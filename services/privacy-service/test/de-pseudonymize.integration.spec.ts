import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys } from '../src/crypto';
import { DePseudonymizeService, DisclosureService } from '../src/disclosure';
import { IdentityVault } from '../src/identity';
import { PolicyEngine } from '../src/policy';
import { RevocationService } from '../src/revocation';
import { TokenService } from '../src/token';

// Seam: DePseudonymizeService.open (POST /de-pseudonymize, spec privacy 4.3, 7.8) on the real privacy database, as
// the real runtime role, with a FakeClock. The request, the approval, the tokens and the vault are made through their
// own services. Every value is invented and plainly false. Needs PostgreSQL and scripts/db/bootstrap.ps1.
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
const APPROVAL_TTL = 600;
const CUSTOMER = 'CUST-000101';
const OTHER_CUSTOMER = 'CUST-000102';
// Values nobody owns; a search of the audit rows, the errors and the logs for any of them must find nothing.
const IDENTITY = {
  nik: '0000000000000001',
  nama: 'Tes Fiktif Satu',
  hp: '081200000001',
  rekening: '555500001111',
};
const VALUES = [CUSTOMER, ...Object.values(IDENTITY)];
const ASKER = { requestingService: 'RECONCILIATION', actorId: 'usr-auditor', actorRole: 'auditor' };
const AUDITOR_CONSOLE = {
  requestingService: 'ADMIN_CONSOLE',
  actorId: 'usr-auditor',
  actorRole: 'auditor',
};
const ADMIN = { requestingService: 'ADMIN_CONSOLE', actorId: 'usr-admin', actorRole: 'admin' };

let db: TestDb;
let clock: FakeClock;
let tokens: TokenService;
let disclosure: DisclosureService;
let revocation: RevocationService;
let vault: IdentityVault;
let service: DePseudonymizeService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm305' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  const operation = new AuditedOperation(db.app, new AuditWriter());
  const policy = new PolicyEngine(TTL);
  const index = new BlindIndex(keys);
  const cipher = new FieldCipher(keys);
  tokens = new TokenService({
    operation,
    policy,
    index,
    cipher,
    mint: new TokenMint(keys),
    clock,
    graceSeconds: 30,
    keyVersion: 1,
  });
  vault = new IdentityVault({ operation, index, cipher, clock, keyVersion: 1 });
  disclosure = new DisclosureService({
    operation,
    policy,
    clock,
    graceSeconds: 30,
    approvalTtlSeconds: APPROVAL_TTL,
  });
  revocation = new RevocationService({ operation, index, vault, clock });
  service = new DePseudonymizeService({ operation, policy, cipher, clock, graceSeconds: 30 });
});
afterEach(async () => {
  await db.close();
});

async function store(customer: string, over: Partial<typeof IDENTITY> = {}): Promise<void> {
  await vault.store({
    requestingService: 'API_GATEWAY',
    customerId: customer,
    ...IDENTITY,
    ...over,
  });
}

/** P1 by the Gateway, then P7 as Reconciliation gets it for an auditor (form 3). */
async function issueP7(customer = CUSTOMER, transactionId = 'TX-9001'): Promise<string> {
  await tokens.generate({
    requestingService: 'API_GATEWAY',
    subjectType: 'CUSTOMER',
    subjectId: customer,
    targetService: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transactionId,
  });
  return (
    await tokens.generateFromTransaction({
      ...ASKER,
      transactionId,
      targetService: 'RECONCILIATION',
      purpose: 'INTERNAL_AUDIT',
      subjectType: 'CUSTOMER',
    })
  ).pseudonym;
}

interface Approved {
  readonly pseudonym: string;
  readonly disclosureId: string;
}
/** A stored identity, its P7 token, and an APPROVED request for the given attributes. */
async function approved(
  attributes: readonly string[] = ['nama'],
  customer = CUSTOMER,
  transactionId = 'TX-9001',
): Promise<Approved> {
  await store(customer);
  const pseudonym = await issueP7(customer, transactionId);
  const requested = await disclosure.request({
    ...AUDITOR_CONSOLE,
    auditToken: pseudonym,
    basis: 'DISPUTE',
    caseRef: 'KASUS-2026-014',
    attributes,
  });
  await disclosure.approve({ ...ADMIN, disclosureId: requested.disclosureId });
  return { pseudonym, disclosureId: requested.disclosureId };
}

const open = (given: Approved, over: Record<string, unknown> = {}) =>
  service.open({
    ...ASKER,
    pseudonym: given.pseudonym,
    purpose: 'INTERNAL_AUDIT',
    disclosureId: given.disclosureId,
    ...over,
  });

const rows = async (sql: string, args: unknown[] = []) =>
  (await db.owner.query<Record<string, unknown>>(sql, args)).rows;
const auditOf = (action: string) =>
  rows('SELECT * FROM audit_log WHERE action = $1 ORDER BY created_at, id', [action]);
const statusOf = async (id: string): Promise<unknown> =>
  (await rows('SELECT status FROM disclosure_request WHERE id = $1', [id]))[0]?.['status'];

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}
/**
 * The refusal is one DENIED row of this reason and the approval is still unused. `work` is a thunk: the count before
 * must be read before the operation starts, else a fast refusal (FORBIDDEN_ROLE reads no row) can commit its row
 * between the call and the read and the count is short by one (TK-08 / AZ-22).
 */
async function expectDenied(given: Approved, reason: string, work: () => Promise<unknown>) {
  const before = (await auditOf('DE_PSEUDONYMIZE')).length;
  expect(await reasonOf(work())).toBe(reason);
  const after = await auditOf('DE_PSEUDONYMIZE');
  expect(after).toHaveLength(before + 1);
  expect(after[after.length - 1]).toMatchObject({ status: 'DENIED', reason });
}

describe('M3-05 FR-09 TK-21 the answer and the audit row', () => {
  it('M3-05 TK-21 an approved request opens only the approved attribute, marks it USED and writes one audit row with names, not values', async () => {
    const given = await approved(['nama']);
    const result = await open(given);
    expect(result.attributes).toEqual({ nama: IDENTITY.nama });
    expect(result.mappingId).toEqual(expect.any(String));
    expect(Object.keys(result)).toEqual(['mappingId', 'attributes']);

    const [row] = await rows('SELECT status, used_at FROM disclosure_request');
    expect(row?.['status']).toBe('USED');
    expect(row?.['used_at']).toEqual(clock.now());
    const audit = await auditOf('DE_PSEUDONYMIZE');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'SUCCESS',
      reason: 'OK',
      requesting_service: 'RECONCILIATION',
      actor_id: 'usr-auditor',
      pseudonym: given.pseudonym,
      purpose: 'INTERNAL_AUDIT',
      disclosure_id: given.disclosureId,
      attribute_names: ['nama'],
    });
  });

  it('M3-05 TK-21 the three attributes are opened when approved; the phone and the account never are', async () => {
    const given = await approved(['customer_id', 'nik', 'nama']);
    const result = await open(given);
    expect(result.attributes).toEqual({
      customer_id: CUSTOMER,
      nik: IDENTITY.nik,
      nama: IDENTITY.nama,
    });
    const answer = JSON.stringify(result);
    expect(answer).not.toContain(IDENTITY.hp);
    expect(answer).not.toContain(IDENTITY.rekening);
  });

  it('M3-05 FR-43 no audit row of the whole table carries any value of the identity', async () => {
    const given = await approved(['customer_id', 'nik', 'nama']);
    await open(given);
    await expectDenied(given, 'DISCLOSURE_NOT_APPROVED', () => open(given));
    const all = JSON.stringify(await rows('SELECT * FROM audit_log'));
    for (const value of VALUES) expect(all).not.toContain(value);
  });
});

describe('M3-05 FR-09 the five gates, in order, stopping at the first failure', () => {
  it('M3-05 TK-23 a PENDING or REJECTED request is DISCLOSURE_NOT_APPROVED', async () => {
    await store(CUSTOMER);
    const pseudonym = await issueP7();
    const pending = (
      await disclosure.request({
        ...AUDITOR_CONSOLE,
        auditToken: pseudonym,
        basis: 'DISPUTE',
        caseRef: 'KASUS-1',
        attributes: ['nama'],
      })
    ).disclosureId;
    await expectDenied({ pseudonym, disclosureId: pending }, 'DISCLOSURE_NOT_APPROVED', () =>
      open({ pseudonym, disclosureId: pending }),
    );
    await disclosure.reject({ ...ADMIN, disclosureId: pending });
    await expectDenied({ pseudonym, disclosureId: pending }, 'DISCLOSURE_NOT_APPROVED', () =>
      open({ pseudonym, disclosureId: pending }),
    );
  });

  it('M3-05 gate 1 an unknown token is TOKEN_NOT_FOUND', async () => {
    const given = await approved();
    await expectDenied(given, 'TOKEN_NOT_FOUND', () => open(given, { pseudonym: 'PSEU-ABCDEF01' }));
  });

  it('M3-05 gate 2 a token of another service is SERVICE_MISMATCH', async () => {
    const given = await approved();
    const p1 = (
      await rows(`SELECT pseudonym FROM pseudonym_mapping WHERE service_id = 'TRANSACTION'`)
    )[0]?.['pseudonym'] as string;
    await expectDenied(given, 'SERVICE_MISMATCH', () => open(given, { pseudonym: p1 }));
  });

  it('M3-05 TK-02 gate 3 a DAILY_RECONCILIATION token asked as INTERNAL_AUDIT is PURPOSE_MISMATCH', async () => {
    const given = await approved();
    // P6 is the token of an ACCOUNT (Tabel 1): P2 by the Gateway, then P6 as Reconciliation gets it.
    await tokens.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'ACCOUNT',
      subjectId: '1234567801',
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId: 'TX-9005',
    });
    const p6 = (
      await tokens.generateFromTransaction({
        requestingService: 'RECONCILIATION',
        transactionId: 'TX-9005',
        targetService: 'RECONCILIATION',
        purpose: 'DAILY_RECONCILIATION',
        subjectType: 'ACCOUNT',
      })
    ).pseudonym;
    await expectDenied(given, 'PURPOSE_MISMATCH', () => open(given, { pseudonym: p6 }));
  });

  it('M3-05 gate 5 an unknown disclosure_id is DISCLOSURE_NOT_FOUND', async () => {
    const given = await approved();
    await expectDenied(given, 'DISCLOSURE_NOT_FOUND', () =>
      open(given, { disclosureId: '11111111-1111-4111-8111-111111111111' }),
    );
  });

  it('M3-05 AZ-22 a service other than RECONCILIATION is POLICY_NOT_ALLOWED', async () => {
    const given = await approved();
    for (const requestingService of ['API_GATEWAY', 'TRANSACTION', 'ADMIN_CONSOLE']) {
      await expectDenied(given, 'POLICY_NOT_ALLOWED', () => open(given, { requestingService }));
    }
    expect(await statusOf(given.disclosureId)).toBe('APPROVED');
  });

  it('M3-05 TK-08 AZ-22 an admin, or no person at all, is FORBIDDEN_ROLE and the approval is not spent', async () => {
    const given = await approved();
    await expectDenied(given, 'FORBIDDEN_ROLE', () => open(given, { actorRole: 'admin' }));
    await expectDenied(given, 'FORBIDDEN_ROLE', () =>
      open(given, { actorId: undefined, actorRole: undefined }),
    );
    expect(await statusOf(given.disclosureId)).toBe('APPROVED');
  });
});

describe('M3-05 K-12 the token must be alive when it is used, not only when it was approved', () => {
  it('M3-05 a token revoked after the approval is REVOKED and the approval is not spent', async () => {
    const given = await approved();
    await revocation.revokeToken({ ...ADMIN, pseudonym: given.pseudonym });
    await expectDenied(given, 'REVOKED', () => open(given));
    expect(await statusOf(given.disclosureId)).toBe('APPROVED');
  });

  it('M3-05 a token past its TTL and grace is EXPIRED, even when the approval would still be valid', async () => {
    const given = await approved();
    clock.advance(631);
    await rows(`UPDATE disclosure_request SET expires_at = $1 WHERE id = $2 RETURNING id`, [
      new Date(clock.now().getTime() + 60_000),
      given.disclosureId,
    ]);
    await expectDenied(given, 'EXPIRED', () => open(given));
  });

  it('M3-05 a token whose identity retention emptied is TOKEN_NOT_FOUND', async () => {
    const given = await approved();
    await db.owner.query(
      `UPDATE pseudonym_mapping SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = $1
        WHERE pseudonym = $2`,
      [clock.now(), given.pseudonym],
    );
    await expectDenied(given, 'TOKEN_NOT_FOUND', () => open(given));
  });

  it('M3-05 K-13 a token whose vault row is gone or emptied is TOKEN_NOT_FOUND', async () => {
    const given = await approved();
    await db.owner.query(
      `UPDATE identity_vault SET customer_id_enc = NULL, nik_enc = NULL, nama_enc = NULL, hp_enc = NULL,
         rekening_enc = NULL, customer_lookup = NULL, purged_at = $1`,
      [clock.now()],
    );
    await expectDenied(given, 'TOKEN_NOT_FOUND', () => open(given));
    expect(await statusOf(given.disclosureId)).toBe('APPROVED');
  });

  it('M3-05 a subject revoked between the approval and the use is REVOKED and nothing is opened', async () => {
    const given = await approved();
    await revocation.revokeSubject({ ...ADMIN, subjectType: 'CUSTOMER', subjectId: CUSTOMER });
    await expectDenied(given, 'REVOKED', () => open(given));
    expect(await statusOf(given.disclosureId)).toBe('APPROVED');
  });
});

describe('M3-05 TK-26 an approval is good for 600 seconds and one use', () => {
  it('M3-05 TK-26 it is still good at exactly 600 seconds and refused a millisecond later', async () => {
    const early = await approved(['nama'], CUSTOMER, 'TX-9001');
    clock.advance(APPROVAL_TTL);
    expect((await open(early)).attributes).toEqual({ nama: IDENTITY.nama });

    const late = await approved(['nama'], OTHER_CUSTOMER, 'TX-9002');
    clock.advance(APPROVAL_TTL + 0.001);
    await expectDenied(late, 'DISCLOSURE_EXPIRED', () => open(late));
    expect(await statusOf(late.disclosureId)).toBe('APPROVED');
  });

  it('M3-05 TK-26 599 seconds after the approval it is still good', async () => {
    const given = await approved();
    clock.advance(599);
    expect((await open(given)).attributes).toEqual({ nama: IDENTITY.nama });
  });

  it('M3-05 TK-26 a second use of the same disclosure_id is DISCLOSURE_NOT_APPROVED and opens nothing', async () => {
    const given = await approved();
    await open(given);
    await expectDenied(given, 'DISCLOSURE_NOT_APPROVED', () => open(given));
    expect(await statusOf(given.disclosureId)).toBe('USED');
    expect(await auditOf('DE_PSEUDONYMIZE')).toHaveLength(2);
  });

  it('M3-05 TK-26 two uses at the same time: exactly one succeeds', async () => {
    const given = await approved();
    const outcomes = await Promise.allSettled([open(given), open(given), open(given)]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect((outcome.reason as DomainError).reason).toBe('DISCLOSURE_NOT_APPROVED');
      }
    }
    const audit = await auditOf('DE_PSEUDONYMIZE');
    expect(audit.filter((row) => row['status'] === 'SUCCESS')).toHaveLength(1);
    expect(audit.filter((row) => row['status'] === 'DENIED')).toHaveLength(2);
    expect(await statusOf(given.disclosureId)).toBe('USED');
  });

  it('M3-05 TK-26 three uses queued behind the row of the approval: exactly one wins, the others see USED', async () => {
    const given = await approved();
    // The overlap is forced, not hoped for: a held lock makes every use wait at the approval, and they are let go
    // together. Without the row lock and the one-time marker all three would read APPROVED and all would succeed.
    const holder = await db.app.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM disclosure_request WHERE id = $1 FOR UPDATE', [
      given.disclosureId,
    ]);
    let settled = 0;
    const uses = [open(given), open(given), open(given)].map((use) =>
      use.then(
        () => 'OK',
        (error: unknown) => (error instanceof DomainError ? error.reason : 'not a DomainError'),
      ),
    );
    uses.forEach((use) => void use.then(() => (settled += 1)));
    const waiting = async (): Promise<number> =>
      Number(
        (
          await db.owner.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
              WHERE d.datname = current_database() AND NOT l.granted`,
          )
        ).rows[0]?.n,
      );
    // Each poll is a round trip, so no sleep is needed; it ends when all three wait, or when one finished anyway.
    const until = Date.now() + 20_000;
    while (Date.now() < until && settled === 0 && (await waiting()) < 3);
    await holder.query('COMMIT');
    holder.release();
    const outcomes = await Promise.all(uses);
    expect(outcomes.filter((outcome) => outcome === 'OK')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'DISCLOSURE_NOT_APPROVED')).toHaveLength(2);
    expect(await statusOf(given.disclosureId)).toBe('USED');
    const audit = await auditOf('DE_PSEUDONYMIZE');
    expect(audit.filter((row) => row['status'] === 'SUCCESS')).toHaveLength(1);
  });

  it('M3-05 a use racing a revocation of the token ends in one of the two orders, never a use of a revoked token', async () => {
    const given = await approved();
    const [, used] = await Promise.allSettled([
      revocation.revokeToken({ ...ADMIN, pseudonym: given.pseudonym }),
      open(given),
    ]);
    const stored = await rows(`SELECT status FROM pseudonym_mapping WHERE pseudonym = $1`, [
      given.pseudonym,
    ]);
    expect(stored[0]?.['status']).toBe('revoked');
    const success = (await auditOf('DE_PSEUDONYMIZE')).filter((row) => row['status'] === 'SUCCESS');
    // Either the use committed first (one SUCCESS, USED) or the revocation did (a REVOKED denial, still APPROVED).
    if (used.status === 'fulfilled') {
      expect(success).toHaveLength(1);
      expect(await statusOf(given.disclosureId)).toBe('USED');
    } else {
      expect((used.reason as DomainError).reason).toBe('REVOKED');
      expect(success).toHaveLength(0);
      expect(await statusOf(given.disclosureId)).toBe('APPROVED');
    }
  });
});

describe('M3-05 FR-09 an approval belongs to its requester and its token', () => {
  it('M3-05 another auditor with the disclosure_id is REQUESTER_MISMATCH and the approval is not spent', async () => {
    const given = await approved();
    await expectDenied(given, 'REQUESTER_MISMATCH', () =>
      open(given, { actorId: 'usr-auditor-two' }),
    );
    expect(await statusOf(given.disclosureId)).toBe('APPROVED');
    expect((await open(given)).attributes).toEqual({ nama: IDENTITY.nama });
  });

  it('M3-05 the disclosure_id of another token is DISCLOSURE_NOT_FOUND and neither request is spent', async () => {
    const first = await approved(['nama'], CUSTOMER, 'TX-9001');
    const second = await approved(['nama'], OTHER_CUSTOMER, 'TX-9002');
    await expectDenied(first, 'DISCLOSURE_NOT_FOUND', () =>
      open(first, { disclosureId: second.disclosureId }),
    );
    await expectDenied(second, 'DISCLOSURE_NOT_FOUND', () =>
      open(second, { disclosureId: first.disclosureId }),
    );
    expect(await statusOf(first.disclosureId)).toBe('APPROVED');
    expect(await statusOf(second.disclosureId)).toBe('APPROVED');
  });
});

describe('M3-05 only the shape is a 422 that touches nothing', () => {
  it('M3-05 a malformed disclosure_id or pseudonym is VALIDATION_ERROR with no audit row', async () => {
    const given = await approved();
    expect(await reasonOf(open(given, { disclosureId: 'not-a-uuid' }))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(open(given, { pseudonym: 'x' }))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(open(given, { purpose: 'internal audit' }))).toBe('VALIDATION_ERROR');
    expect(await auditOf('DE_PSEUDONYMIZE')).toHaveLength(0);
  });
});
