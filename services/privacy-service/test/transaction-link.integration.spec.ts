import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditReader, AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys } from '../src/crypto';
import { PolicyEngine } from '../src/policy';
import { RetentionJob } from '../src/retention';
import { TokenService, type FromTransactionRequest, type GenerateRequest } from '../src/token';

// Seam: the table that ties a transaction id to the token issued for it (K-28, ADR-0013), on the real privacy
// database as the real runtime roles, with a FakeClock. Every value is invented. Needs PostgreSQL and
// scripts/db/bootstrap.ps1.
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
const GRACE = 30;
const RETENTION_DAYS = 30;
const CUSTOMER = 'CUST-000301';
const OTHER_CUSTOMER = 'CUST-000302';
const START = '2026-10-20T08:00:00.000Z';

let db: TestDb;
let clock: FakeClock;
let reader: AuditReader;
let service: TokenService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'k28' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  reader = new AuditReader(db.auditor);
  clock = new FakeClock(START);
  service = new TokenService({
    operation: new AuditedOperation(db.app, new AuditWriter()),
    policy: new PolicyEngine(TTL),
    index: new BlindIndex(keys),
    cipher: new FieldCipher(keys),
    mint: new TokenMint(keys),
    clock,
    graceSeconds: GRACE,
    keyVersion: 1,
  });
});
afterEach(async () => {
  await db.close();
});

const p1 = (transactionId: string, subjectId = CUSTOMER): GenerateRequest => ({
  requestingService: 'API_GATEWAY',
  subjectType: 'CUSTOMER',
  subjectId,
  targetService: 'TRANSACTION',
  purpose: 'PAYMENT_PROCESSING',
  transactionId,
});
const p7 = (transactionId: string): FromTransactionRequest => ({
  requestingService: 'RECONCILIATION',
  transactionId,
  targetService: 'RECONCILIATION',
  purpose: 'INTERNAL_AUDIT',
  subjectType: 'CUSTOMER',
  actorRole: 'auditor',
  actorId: 'auditor-a',
});
const reasonOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'OK';
  } catch (error) {
    return String((error as { reason?: unknown }).reason);
  }
};
const count = async (table: string): Promise<number> => {
  // The table name is a constant of this test.
  const { rows } = await db.owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
};
const linkOf = async (transactionId: string, subjectType = 'CUSTOMER') =>
  (
    await db.owner.query<{ pseudonym: string; service_id: string; purpose: string }>(
      `SELECT pseudonym, service_id, purpose FROM transaction_link
        WHERE transaction_id = $1 AND subject_type = $2 AND service_id = 'TRANSACTION'`,
      [transactionId, subjectType],
    )
  ).rows[0];
const rowOf = async (pseudonym: string): Promise<Record<string, unknown> | undefined> =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM pseudonym_mapping WHERE pseudonym = $1',
      [pseudonym],
    )
  ).rows[0];
const lastAudit = async () => (await reader.query({ limit: 1 }))[0];

describe('K-28 a token reused for a second transaction is found by both', () => {
  it('K-28 two transactions inside one TTL can both be found by form 3', async () => {
    const first = await service.generate(p1('TX-8001'));
    clock.advance(60);
    const second = await service.generate(p1('TX-8002'));
    expect(second.reused).toBe(true);
    expect(second.pseudonym).toBe(first.pseudonym);

    const a = await service.generateFromTransaction(p7('TX-8001'));
    const b = await service.generateFromTransaction(p7('TX-8002'));
    expect(a.pseudonym).toMatch(/^PSEU-/);
    expect(b.pseudonym).toBe(a.pseudonym);
    expect((await linkOf('TX-8001'))?.pseudonym).toBe(first.pseudonym);
    expect((await linkOf('TX-8002'))?.pseudonym).toBe(first.pseudonym);
  });

  it('K-28 writing the same link again is a no-op, in parallel too', async () => {
    const results = await Promise.all([
      service.generate(p1('TX-8003')),
      service.generate(p1('TX-8003')),
      service.generate(p1('TX-8003')),
    ]);
    expect(new Set(results.map((r) => r.pseudonym)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(await count('transaction_link')).toBe(1);
  });

  it('K-28 a link carries no identity: the columns are the key, the token and the time', async () => {
    const { rows } = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'transaction_link' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'created_at',
      'pseudonym',
      'purpose',
      'service_id',
      'subject_type',
      'transaction_id',
    ]);
  });
});

describe('K-28 one transaction id, one token per context', () => {
  it('K-28 the same transaction id with another pseudonym is refused, audited, and nothing is issued', async () => {
    const first = await service.generate(p1('TX-8010'));
    const mappings = await count('pseudonym_mapping');
    const audits = await reader.query({ limit: 500 });

    expect(await reasonOf(service.generate(p1('TX-8010', OTHER_CUSTOMER)))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(await count('pseudonym_mapping')).toBe(mappings);
    expect((await linkOf('TX-8010'))?.pseudonym).toBe(first.pseudonym);
    expect(await lastAudit()).toMatchObject({
      action: 'GENERATE_TOKEN',
      status: 'DENIED',
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect((await reader.query({ limit: 500 })).length).toBe(audits.length + 1);
  });

  it('K-28 two parallel requests for one transaction id and two people: one wins, one is refused', async () => {
    const outcomes = await Promise.all([
      reasonOf(service.generate(p1('TX-8011', CUSTOMER))),
      reasonOf(service.generate(p1('TX-8011', OTHER_CUSTOMER))),
    ]);
    expect(outcomes.sort()).toEqual(['IDEMPOTENCY_CONFLICT', 'OK']);
    expect(await count('pseudonym_mapping')).toBe(1);
    expect(await count('transaction_link')).toBe(1);
  });

  it('K-28 the same transaction id in another context is not a conflict (the exchange keeps working)', async () => {
    const source = await service.generate(p1('TX-8012'));
    const exchanged = await service.exchange({
      requestingService: 'TRANSACTION',
      sourcePseudonym: source.pseudonym,
      targetService: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      transactionId: 'TX-8012',
    });
    expect(exchanged.pseudonym).not.toBe(source.pseudonym);
    expect(await count('transaction_link')).toBe(2);
  });
});

describe('K-28 re-issue keeps the original transaction id of the row', () => {
  it('K-28 the new row keeps the original id, the link moves to the new token, the other link stays', async () => {
    const first = await service.generate(p1('TX-8020'));
    await service.generate(p1('TX-8021'));
    clock.advance(1_000);
    const renewed = await service.reIssue({
      requestingService: 'TRANSACTION',
      pseudonym: first.pseudonym,
      transactionId: 'TX-8021',
    });
    expect(renewed.pseudonym).not.toBe(first.pseudonym);
    expect(await rowOf(renewed.pseudonym)).toMatchObject({ transaction_id: 'TX-8020' });
    expect((await linkOf('TX-8021'))?.pseudonym).toBe(renewed.pseudonym);
    expect((await linkOf('TX-8020'))?.pseudonym).toBe(first.pseudonym);
    // Both are still found: the old one is expired, which form 3 accepts.
    expect(await reasonOf(service.generateFromTransaction(p7('TX-8020')))).toBe('OK');
    expect(await reasonOf(service.generateFromTransaction(p7('TX-8021')))).toBe('OK');
  });
});

describe('K-28 a re-issue may only take over the link of the token it replaces', () => {
  it('K-28 re-issuing a token for a transaction id that is linked to another token is refused and changes nothing', async () => {
    const owner = await service.generate(p1('TX-8025', CUSTOMER));
    const other = await service.generate(p1('TX-8026', OTHER_CUSTOMER));
    clock.advance(1_000);
    expect(
      await reasonOf(
        service.reIssue({
          requestingService: 'TRANSACTION',
          pseudonym: other.pseudonym,
          transactionId: 'TX-8025',
        }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect((await linkOf('TX-8025'))?.pseudonym).toBe(owner.pseudonym);
    expect((await linkOf('TX-8026'))?.pseudonym).toBe(other.pseudonym);
    expect(await rowOf(other.pseudonym)).toMatchObject({ status: 'active' });
    expect(await count('pseudonym_mapping')).toBe(2);
  });
});

describe('K-28 a re-issue never plants a link', () => {
  it('K-28 re-issuing for a transaction id that has no link to this token is refused, and no link appears', async () => {
    const own = await service.generate(p1('TX-8027'));
    clock.advance(1_000);
    expect(
      await reasonOf(
        service.reIssue({
          requestingService: 'TRANSACTION',
          pseudonym: own.pseudonym,
          transactionId: 'TX-8099',
        }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(await linkOf('TX-8099')).toBeUndefined();
    expect(await count('transaction_link')).toBe(1);
    expect(await rowOf(own.pseudonym)).toMatchObject({ status: 'active' });
  });
});

describe('K-29 form 3 from a revoked source', () => {
  it('K-29 is refused as REVOKED and audited, nothing is issued', async () => {
    const first = await service.generate(p1('TX-8030'));
    await db.owner.query(
      `UPDATE pseudonym_mapping SET status = 'revoked', revoked_at = $2 WHERE pseudonym = $1`,
      [first.pseudonym, clock.now()],
    );
    const mappings = await count('pseudonym_mapping');
    expect(await reasonOf(service.generateFromTransaction(p7('TX-8030')))).toBe('REVOKED');
    expect(await count('pseudonym_mapping')).toBe(mappings);
    expect(await lastAudit()).toMatchObject({ status: 'DENIED', reason: 'REVOKED' });
  });
});

describe('K-28 retention removes the link with its row', () => {
  it('K-28 the link goes when the identity of its row is emptied; the audit rows are not touched', async () => {
    const first = await service.generate(p1('TX-8040'));
    await service.generate(p1('TX-8041'));
    expect(await count('transaction_link')).toBe(2);
    clock.advance((RETENTION_DAYS + 1) * 86_400);
    const job = new RetentionJob({
      pool: db.app,
      clock,
      graceSeconds: GRACE,
      retentionDays: RETENTION_DAYS,
    });
    const audits = (await reader.query({ limit: 500 })).filter(
      (r) => r.action !== 'PURGE_IDENTITY',
    );

    expect(await job.run()).toMatchObject({ purged: 1 });
    expect(await count('transaction_link')).toBe(0);
    expect(await rowOf(first.pseudonym)).toMatchObject({ subject_id_enc: null });
    expect(
      (await reader.query({ limit: 500 })).filter((r) => r.action !== 'PURGE_IDENTITY'),
    ).toEqual(audits);
    expect(await reasonOf(service.generateFromTransaction(p7('TX-8040')))).toBe('TOKEN_NOT_FOUND');
  });
});

describe('K-28 grants: the application may delete links and nothing else', () => {
  it('K-28 TK-10 privpay_app can delete a link; privpay_auditor cannot even read one', async () => {
    await service.generate(p1('TX-8050'));
    await expect(db.app.query('DELETE FROM transaction_link')).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(db.auditor?.query('SELECT 1 FROM transaction_link')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
