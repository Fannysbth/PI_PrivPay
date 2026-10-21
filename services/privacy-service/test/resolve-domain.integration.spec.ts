import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys } from '../src/crypto';
import { PolicyEngine } from '../src/policy';
import { TokenService } from '../src/token';

// Seam: TokenService.resolveDomain on the real privacy database, as the real runtime role, with a FakeClock.
// Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

const keys = createKeys({
  token: Buffer.alloc(32, 1),
  index: Buffer.alloc(32, 2),
  field: new Map([[1, Buffer.alloc(32, 3)]]),
  fieldVersion: 1,
});
const TTL = {
  PAYMENT_PROCESSING: 900,
  FRAUD_DETECTION: 2_592_000,
  NOTIFICATION: 900,
  NOTIFICATION_REGISTRATION: 31_536_000,
  DAILY_RECONCILIATION: 86_400,
  INTERNAL_AUDIT: 600,
};
const CUSTOMER = 'CUST-000101';
const OTHER_CUSTOMER = 'CUST-000102';

let db: TestDb;
let clock: FakeClock;
let service: TokenService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm301' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  service = new TokenService({
    operation: new AuditedOperation(db.app, new AuditWriter()),
    policy: new PolicyEngine(TTL),
    index: new BlindIndex(keys),
    cipher: new FieldCipher(keys),
    mint: new TokenMint(keys),
    clock,
    graceSeconds: 30,
    keyVersion: 1,
  });
});
afterEach(async () => {
  await db.close();
});

/** P1 by the Gateway, then X2: the notification token (P4) the way Transaction trades it. */
async function issueP4(customer = CUSTOMER, transactionId = 'TX-6001'): Promise<string> {
  const p1 = await service.generate({
    requestingService: 'API_GATEWAY',
    subjectType: 'CUSTOMER',
    subjectId: customer,
    targetService: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transactionId,
  });
  return (
    await service.exchange({
      requestingService: 'TRANSACTION',
      sourcePseudonym: p1.pseudonym,
      targetService: 'NOTIFICATION',
      purpose: 'NOTIFICATION',
      transactionId,
    })
  ).pseudonym;
}
/** P5 by the Gateway at registration (flow A5). */
async function issueP5(customer = CUSTOMER): Promise<string> {
  return (
    await service.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'CUSTOMER',
      subjectId: customer,
      targetService: 'NOTIFICATION',
      purpose: 'NOTIFICATION_REGISTRATION',
    })
  ).pseudonym;
}

const resolve = (token: string, requestingService = 'NOTIFICATION') =>
  service.resolveDomain({ requestingService, notifToken: token });

const auditRows = async () =>
  (await db.owner.query<Record<string, unknown>>('SELECT * FROM audit_log ORDER BY created_at, id'))
    .rows;
const auditActions = async (action: string) =>
  (await auditRows()).filter((row) => row['action'] === action);
const idOf = async (pseudonym: string): Promise<string> =>
  (
    await db.owner.query<{ id: string }>('SELECT id FROM pseudonym_mapping WHERE pseudonym = $1', [
      pseudonym,
    ])
  ).rows[0]?.id ?? '';

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}

/** Expects one new RESOLVE_NOTIF_DOMAIN row, DENIED with this reason. */
async function expectOneDenial(reason: string): Promise<Record<string, unknown>> {
  const rows = await auditActions('RESOLVE_NOTIF_DOMAIN');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'DENIED', reason, requesting_service: 'NOTIFICATION' });
  return rows[0] as Record<string, unknown>;
}

describe('M3-01 FR-08 resolve-domain: the notification token to the domain pseudonym (spec privacy 7.6)', () => {
  it('M3-01 FR-08 gives the P5 token of the same subject and nothing else, with one SUCCESS row', async () => {
    const p5 = await issueP5();
    const p4 = await issueP4();
    const result = await resolve(p4);
    expect(result).toEqual({ notificationDomainId: p5 });
    expect(result.notificationDomainId).toMatch(/^PSEU-[0-9A-F]{8}$/);
    const rows = await auditActions('RESOLVE_NOTIF_DOMAIN');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'SUCCESS',
      reason: 'OK',
      requesting_service: 'NOTIFICATION',
      pseudonym: p4,
      mapping_id: await idOf(p4),
      purpose: 'NOTIFICATION',
    });
  });

  it('M3-01 FR-08 the P5 of another subject is never given', async () => {
    await issueP5(OTHER_CUSTOMER);
    const p4 = await issueP4();
    expect(await reasonOf(resolve(p4))).toBe('TOKEN_NOT_FOUND');
    await expectOneDenial('TOKEN_NOT_FOUND');
  });

  it('M3-01 FR-08 POLICY_NOT_ALLOWED for a caller that is not NOTIFICATION, before any token is read', async () => {
    const p4 = await issueP4();
    expect(await reasonOf(resolve(p4, 'TRANSACTION'))).toBe('POLICY_NOT_ALLOWED');
    const rows = await auditActions('RESOLVE_NOTIF_DOMAIN');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'DENIED',
      reason: 'POLICY_NOT_ALLOWED',
      requesting_service: 'TRANSACTION',
      mapping_id: null,
    });
  });

  it('M3-01 FR-08 TOKEN_NOT_FOUND for a token nobody issued', async () => {
    expect(await reasonOf(resolve('PSEU-00000000'))).toBe('TOKEN_NOT_FOUND');
    await expectOneDenial('TOKEN_NOT_FOUND');
  });

  it('M3-01 FR-08 SERVICE_MISMATCH for a token of another service', async () => {
    await issueP5();
    const p1 = (
      await service.generate({
        requestingService: 'API_GATEWAY',
        subjectType: 'CUSTOMER',
        subjectId: CUSTOMER,
        targetService: 'TRANSACTION',
        purpose: 'PAYMENT_PROCESSING',
        transactionId: 'TX-6002',
      })
    ).pseudonym;
    expect(await reasonOf(resolve(p1))).toBe('SERVICE_MISMATCH');
    const row = await expectOneDenial('SERVICE_MISMATCH');
    expect(row['pseudonym']).toBe(p1);
  });

  it('M3-01 FR-08 PURPOSE_MISMATCH for a token of NOTIFICATION that is not the notification one (the P5 itself)', async () => {
    const p5 = await issueP5();
    expect(await reasonOf(resolve(p5))).toBe('PURPOSE_MISMATCH');
    await expectOneDenial('PURPOSE_MISMATCH');
  });

  it('M3-01 FR-08 REVOKED', async () => {
    await issueP5();
    const p4 = await issueP4();
    await db.owner.query(
      "UPDATE pseudonym_mapping SET status = 'revoked', revoked_at = $2 WHERE pseudonym = $1",
      [p4, clock.now()],
    );
    expect(await reasonOf(resolve(p4))).toBe('REVOKED');
    await expectOneDenial('REVOKED');
  });

  it('M3-01 FR-08 EXPIRED: past the TTL and the grace period, exactly at the edge (qa C-01)', async () => {
    const p5 = await issueP5();
    const p4 = await issueP4();
    clock.advance(930); // TTL 900 s + grace 30 s: not yet past the grace period
    await expect(resolve(p4)).resolves.toEqual({ notificationDomainId: p5 });
    clock.advance(1);
    expect(await reasonOf(resolve(p4))).toBe('EXPIRED');
    const rows = await auditActions('RESOLVE_NOTIF_DOMAIN');
    expect(rows.map((row) => row['reason'])).toEqual(['OK', 'EXPIRED']);
  });

  it('M3-01 FR-08 a live token with no identity left is TOKEN_NOT_FOUND', async () => {
    await issueP5();
    const p4 = await issueP4();
    await db.owner.query(
      'UPDATE pseudonym_mapping SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = $2 WHERE pseudonym = $1',
      [p4, clock.now()],
    );
    expect(await reasonOf(resolve(p4))).toBe('TOKEN_NOT_FOUND');
  });

  it('M3-01 FR-08 no active P5 (never registered, or revoked, or past its TTL) is TOKEN_NOT_FOUND', async () => {
    const p4 = await issueP4();
    expect(await reasonOf(resolve(p4))).toBe('TOKEN_NOT_FOUND');
    const p5 = await issueP5();
    await db.owner.query("UPDATE pseudonym_mapping SET status = 'revoked' WHERE pseudonym = $1", [
      p5,
    ]);
    expect(await reasonOf(resolve(p4))).toBe('TOKEN_NOT_FOUND');
  });

  it('M3-01 FR-08 each gate stops at the first failure: a revoked token of another service is SERVICE_MISMATCH, an expired P5 is PURPOSE_MISMATCH', async () => {
    const p5 = await issueP5();
    await db.owner.query("UPDATE pseudonym_mapping SET status = 'revoked' WHERE pseudonym = $1", [
      p5,
    ]);
    expect(await reasonOf(resolve(p5))).toBe('PURPOSE_MISMATCH');
    const p1 = (
      await service.generate({
        requestingService: 'API_GATEWAY',
        subjectType: 'CUSTOMER',
        subjectId: CUSTOMER,
        targetService: 'TRANSACTION',
        purpose: 'PAYMENT_PROCESSING',
        transactionId: 'TX-6003',
      })
    ).pseudonym;
    await db.owner.query("UPDATE pseudonym_mapping SET status = 'revoked' WHERE pseudonym = $1", [
      p1,
    ]);
    expect(await reasonOf(resolve(p1))).toBe('SERVICE_MISMATCH');
    expect(await auditActions('RESOLVE_NOTIF_DOMAIN')).toHaveLength(2);
  });

  it('M3-01 NFR-14 a malformed token is a 422 and is not audited (spec privacy 9.4)', async () => {
    expect(await reasonOf(resolve('not-a-token'))).toBe('VALIDATION_ERROR');
    expect(await auditActions('RESOLVE_NOTIF_DOMAIN')).toHaveLength(0);
  });
});
