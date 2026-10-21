import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditReader, AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys, mappingBinding } from '../src/crypto';
import { PolicyEngine } from '../src/policy';
import { RetentionJob } from '../src/retention';
import { TokenService } from '../src/token';

// Seam: RetentionJob.run and overdueCount on the real privacy database, as the real runtime role, with a FakeClock and
// rows that are older than 90 days. The oracles below are written as SQL of their own, not taken from the job. Every
// value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

const keys = createKeys({
  token: Buffer.alloc(32, 1),
  index: Buffer.alloc(32, 2),
  field: new Map([[1, Buffer.alloc(32, 3)]]),
  fieldVersion: 1,
});
const index = new BlindIndex(keys);
const cipher = new FieldCipher(keys);
const GRACE = 30;
const RETENTION_DAYS = 90;
const NOW = '2026-10-20T01:00:00.000Z';
const DAY = 86_400_000;

let db: TestDb;
let clock: FakeClock;
let reader: AuditReader;
let job: RetentionJob;

const newJob = (over: Partial<ConstructorParameters<typeof RetentionJob>[0]> = {}): RetentionJob =>
  new RetentionJob({
    pool: db.app,
    clock,
    graceSeconds: GRACE,
    retentionDays: RETENTION_DAYS,
    ...over,
  });

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm209' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  reader = new AuditReader(db.auditor);
  clock = new FakeClock(NOW);
  job = newJob();
});
afterEach(async () => {
  await db.close();
});

const ago = (ms: number): Date => new Date(new Date(NOW).getTime() - ms);

interface RowSpec {
  pseudonym: string;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: Date;
  revokedAt?: Date;
  subjectId?: string;
  service?: string;
  purpose?: string;
  transactionId?: string;
}

/** A mapping row as the other operations leave it, with the time stamps the case is about. */
async function insertRow(spec: RowSpec): Promise<string> {
  const id = randomUUID();
  const subjectId = spec.subjectId ?? 'CUST-000101';
  await db.owner.query(
    `INSERT INTO pseudonym_mapping
       (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, transaction_id,
        created_at, expires_at, revoked_at, status)
     VALUES ($1, 'CUSTOMER', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      cipher.encrypt(subjectId, mappingBinding('CUSTOMER', id)),
      index.lookup('CUSTOMER', subjectId),
      spec.pseudonym,
      spec.service ?? 'TRANSACTION',
      spec.purpose ?? 'PAYMENT_PROCESSING',
      spec.transactionId ?? null,
      ago(200 * DAY),
      spec.expiresAt,
      spec.revokedAt ?? null,
      spec.status,
    ],
  );
  return id;
}

const rowOf = async (pseudonym: string): Promise<Record<string, unknown> | undefined> =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM pseudonym_mapping WHERE pseudonym = $1',
      [pseudonym],
    )
  ).rows[0];
const isPurged = async (pseudonym: string): Promise<boolean> =>
  (await rowOf(pseudonym))?.['purged_at'] !== null;
const count = async (table: string): Promise<number> => {
  // The table name is a constant of this test.
  const { rows } = await db.owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
};
/** The check of PRD 6.2: no row that stopped being valid long ago still holds an identity. */
const overdueByOracle = async (): Promise<number> => {
  const { rows } = await db.owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM pseudonym_mapping
      WHERE subject_id_enc IS NOT NULL AND status IN ('expired', 'revoked')
        AND COALESCE(revoked_at, expires_at) < $1::timestamptz - make_interval(days => 90)`,
    [NOW],
  );
  return Number(rows[0]?.n);
};

describe('M2-09 FR-31 step 1: an active row past its TTL and grace is marked expired', () => {
  it('M2-09 FR-31 the boundary is exact: at expires_at + grace the row is still active, a millisecond later it is expired', async () => {
    await insertRow({
      pseudonym: 'PSEU-00000001',
      status: 'active',
      subjectId: 'CUST-000801',
      expiresAt: ago(GRACE * 1000),
    });
    await insertRow({
      pseudonym: 'PSEU-00000002',
      status: 'active',
      subjectId: 'CUST-000802',
      expiresAt: ago(GRACE * 1000 + 1),
    });
    await insertRow({
      pseudonym: 'PSEU-00000003',
      status: 'active',
      subjectId: 'CUST-000803',
      expiresAt: ago(-60_000),
    });
    const result = await job.run();
    expect(result.expired).toBe(1);
    expect((await rowOf('PSEU-00000001'))?.['status']).toBe('active');
    expect((await rowOf('PSEU-00000002'))?.['status']).toBe('expired');
    expect((await rowOf('PSEU-00000003'))?.['status']).toBe('active');
  });

  it('M2-09 FR-31 marking is not audited and does not purge a row that expired recently', async () => {
    await insertRow({ pseudonym: 'PSEU-00000004', status: 'active', expiresAt: ago(2 * DAY) });
    await job.run();
    expect(await isPurged('PSEU-00000004')).toBe(false);
    expect(await count('audit_log')).toBe(0);
  });
});

describe('M2-09 FR-31 NFR-18 C-06 step 2: identity is emptied from rows that stopped being valid 90 days ago', () => {
  it('M2-09 FR-31 an old expired row loses its ciphertext and lookup, keeps its row, and satisfies chk_purged', async () => {
    const id = await insertRow({
      pseudonym: 'PSEU-00000010',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY + 1000),
      transactionId: 'TX-8001',
    });
    const result = await job.run();
    expect(result.purged).toBe(1);
    expect(await rowOf('PSEU-00000010')).toMatchObject({
      id,
      subject_id_enc: null,
      subject_lookup: null,
      purged_at: new Date(NOW),
      status: 'expired',
      pseudonym: 'PSEU-00000010',
      transaction_id: 'TX-8001',
    });
  });

  it('M2-09 FR-31 one PURGE_IDENTITY row per purged row, by SYSTEM, naming the mapping and no identity', async () => {
    const id = await insertRow({
      pseudonym: 'PSEU-00000011',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY + 1000),
    });
    await job.run();
    const audit = await reader.query({});
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'PURGE_IDENTITY',
      status: 'SUCCESS',
      reason: 'OK',
      actorId: 'SYSTEM',
      pseudonym: 'PSEU-00000011',
      mappingId: id,
      purpose: 'PAYMENT_PROCESSING',
    });
    expect(JSON.stringify(audit)).not.toContain('CUST-000101');
    // The audit row still points at a row that exists (the foreign key is the proof, the row is the evidence).
    expect(await rowOf('PSEU-00000011')).toMatchObject({ id });
  });

  it('M2-09 FR-31 the boundary is exact: COALESCE(revoked_at, expires_at) a millisecond inside 90 days stays, a millisecond past goes', async () => {
    await insertRow({
      pseudonym: 'PSEU-00000012',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY),
    });
    await insertRow({
      pseudonym: 'PSEU-00000013',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY + 1),
    });
    await job.run();
    expect(await isPurged('PSEU-00000012')).toBe(false);
    expect(await isPurged('PSEU-00000013')).toBe(true);
  });

  it('M2-09 FR-31 a revoked row counts from the revocation, an expired-then-revoked row too (K-11)', async () => {
    const longAgo = ago(RETENTION_DAYS * DAY + 1000);
    await insertRow({
      pseudonym: 'PSEU-00000014',
      status: 'revoked',
      expiresAt: longAgo,
      revokedAt: ago(DAY),
    });
    await insertRow({
      pseudonym: 'PSEU-00000015',
      status: 'revoked',
      expiresAt: ago(DAY),
      revokedAt: longAgo,
    });
    await insertRow({
      pseudonym: 'PSEU-00000016',
      status: 'revoked',
      expiresAt: longAgo,
      revokedAt: longAgo,
    });
    await job.run();
    expect(await isPurged('PSEU-00000014')).toBe(false);
    expect(await isPurged('PSEU-00000015')).toBe(true);
    expect(await isPurged('PSEU-00000016')).toBe(true);
  });

  it('M2-09 FR-31 an active row that nobody marked and that is older than 90 days is marked and purged in the same run', async () => {
    await insertRow({
      pseudonym: 'PSEU-00000017',
      status: 'active',
      expiresAt: ago(RETENTION_DAYS * DAY + 5000),
    });
    const result = await job.run();
    expect(result).toEqual({ expired: 1, purged: 1 });
    expect(await rowOf('PSEU-00000017')).toMatchObject({ status: 'expired', subject_id_enc: null });
  });

  it('M2-09 FR-31 a row that is already purged is left alone: nothing changes, no second audit row', async () => {
    await insertRow({
      pseudonym: 'PSEU-00000018',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY + 1000),
    });
    await job.run();
    const first = await rowOf('PSEU-00000018');
    clock.advance(3600);
    const second = await job.run();
    expect(second).toEqual({ expired: 0, purged: 0 });
    expect(await rowOf('PSEU-00000018')).toEqual(first);
    expect(await count('audit_log')).toBe(1);
  });

  it('M2-09 TF-14 the check query: rows overdue before the run, none after (by an oracle that is not the job)', async () => {
    for (let i = 0; i < 7; i += 1) {
      await insertRow({
        pseudonym: `PSEU-0000002${String(i)}`,
        status: i % 2 === 0 ? 'expired' : 'revoked',
        expiresAt: ago(RETENTION_DAYS * DAY + 1000 * (i + 1)),
        revokedAt: i % 2 === 0 ? undefined : ago(RETENTION_DAYS * DAY + 1000 * (i + 1)),
        subjectId: `CUST-00020${String(i)}`,
      });
    }
    expect(await overdueByOracle()).toBe(7);
    expect(await job.overdueCount()).toBe(7);
    await job.run();
    expect(await overdueByOracle()).toBe(0);
    expect(await job.overdueCount()).toBe(0);
  });

  it('M2-09 FR-31 nothing is deleted: the row count is the same after the run', async () => {
    for (let i = 0; i < 4; i += 1) {
      await insertRow({
        pseudonym: `PSEU-0000003${String(i)}`,
        status: 'expired',
        expiresAt: ago(RETENTION_DAYS * DAY + 1000),
        subjectId: `CUST-00030${String(i)}`,
      });
    }
    const before = await count('pseudonym_mapping');
    await job.run();
    expect(await count('pseudonym_mapping')).toBe(before);
  });

  it('M2-09 FR-31 the identity vault is not part of the job (PRD 6.2)', async () => {
    await insertRow({
      pseudonym: 'PSEU-00000040',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY + 1000),
    });
    await db.owner.query(
      `INSERT INTO identity_vault (customer_lookup, customer_id_enc, nik_enc, created_at)
       VALUES ($1, $2, $3, $4)`,
      [Buffer.alloc(32, 9), Buffer.alloc(40, 8), Buffer.alloc(40, 7), ago(400 * DAY)],
    );
    await job.run();
    const { rows } = await db.owner.query(
      'SELECT customer_lookup, customer_id_enc, nik_enc, purged_at FROM identity_vault',
    );
    expect(rows).toEqual([
      {
        customer_lookup: Buffer.alloc(32, 9),
        customer_id_enc: Buffer.alloc(40, 8),
        nik_enc: Buffer.alloc(40, 7),
        purged_at: null,
      },
    ]);
  });
});

describe('M2-09 NFR-18 batches, atomicity and rows in use', () => {
  it('M2-09 NFR-18 more rows than one batch: every one is purged, in batches, with one audit row each', async () => {
    await db.owner.query(
      `INSERT INTO pseudonym_mapping
         (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, created_at, expires_at, status)
       SELECT 'CUSTOMER', '\\x01'::bytea, decode(lpad(to_hex(g), 64, '0'), 'hex'),
              'PSEU-' || lpad(upper(to_hex(g)), 8, '0'), 'TRANSACTION', 'PAYMENT_PROCESSING',
              $1::timestamptz, $2::timestamptz, 'expired'
         FROM generate_series(1, 650) AS g`,
      [ago(300 * DAY), ago(RETENTION_DAYS * DAY + 60_000)],
    );
    const result = await newJob({ batchSize: 100 }).run();
    expect(result.purged).toBe(650);
    expect(await overdueByOracle()).toBe(0);
    expect(await count('audit_log')).toBe(650);
  });

  it('M2-09 FR-13 a batch whose audit rows the database refuses is rolled back whole: the identities stay, the run fails', async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertRow({
        pseudonym: `PSEU-0000005${String(i)}`,
        status: 'expired',
        expiresAt: ago(RETENTION_DAYS * DAY + 1000),
        subjectId: `CUST-00050${String(i)}`,
      });
    }
    await db.owner.query(`
      CREATE FUNCTION refuse_audit_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
      CREATE CONSTRAINT TRIGGER refuse_audit AFTER INSERT ON audit_log
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_audit_at_commit();`);
    await expect(job.run()).rejects.toBeInstanceOf(Error);
    expect(await overdueByOracle()).toBe(5);
    expect(await count('audit_log')).toBe(0);
  });

  it('M2-09 FR-31 step 1 does not wait for a row in use either: it is marked by the next run', async () => {
    await insertRow({
      pseudonym: 'PSEU-00000062',
      status: 'active',
      expiresAt: ago(2 * DAY),
      subjectId: 'CUST-000603',
    });
    await insertRow({
      pseudonym: 'PSEU-00000063',
      status: 'active',
      expiresAt: ago(2 * DAY),
      subjectId: 'CUST-000604',
    });
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      // What a re-issue or an exchange in flight holds on a row (spec 7.5, 7.7).
      await holder.query(
        `SELECT id FROM pseudonym_mapping WHERE pseudonym = 'PSEU-00000062' FOR SHARE`,
      );
      const state = { settled: false, queued: false };
      const running = job.run().then((result) => {
        state.settled = true;
        return result;
      });
      // If the job queues behind the holder it is waiting, and the holder is only released below: that would be the
      // circular wait that SKIP LOCKED avoids. It is observed in pg_locks, without a sleep. The wait ends only when the
      // job has settled or is seen queued (a bounded poll count could end before the job reached its UPDATE on a loaded
      // machine and release the lock too early); the test timeout bounds it if neither ever happens.
      while (!state.settled && !state.queued) {
        const { rows } = await db.owner.query(
          `SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`,
        );
        state.queued = rows.length > 0;
      }
      await holder.query('COMMIT');
      const result = await running;
      expect(state.queued).toBe(false);
      expect(result.expired).toBe(1);
      expect((await rowOf('PSEU-00000062'))?.['status']).toBe('active');
      expect((await rowOf('PSEU-00000063'))?.['status']).toBe('expired');
    } finally {
      holder.release();
    }
    expect((await job.run()).expired).toBe(1);
    expect((await rowOf('PSEU-00000062'))?.['status']).toBe('expired');
  });

  it('M2-09 FR-31 a row in use by another transaction is left for the next run, not waited for and not skipped for ever', async () => {
    await insertRow({
      pseudonym: 'PSEU-00000060',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY + 1000),
      subjectId: 'CUST-000601',
    });
    await insertRow({
      pseudonym: 'PSEU-00000061',
      status: 'expired',
      expiresAt: ago(RETENTION_DAYS * DAY + 1000),
      subjectId: 'CUST-000602',
    });
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      // What an exchange in flight holds on its source row (spec 7.5).
      await holder.query(
        `SELECT id FROM pseudonym_mapping WHERE pseudonym = 'PSEU-00000060' FOR SHARE`,
      );
      const result = await job.run();
      expect(result.purged).toBe(1);
      expect(await isPurged('PSEU-00000060')).toBe(false);
      expect(await isPurged('PSEU-00000061')).toBe(true);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    expect((await job.run()).purged).toBe(1);
    expect(await isPurged('PSEU-00000060')).toBe(true);
  });

  it('M2-09 FR-31 running the job twice at once purges each row once and writes one audit row per row', async () => {
    for (let i = 0; i < 30; i += 1) {
      await insertRow({
        pseudonym: `PSEU-${(0x700 + i).toString(16).toUpperCase().padStart(8, '0')}`,
        status: 'expired',
        expiresAt: ago(RETENTION_DAYS * DAY + 1000),
        subjectId: `CUST-${String(700 + i).padStart(6, '0')}`,
      });
    }
    const results = await Promise.all([
      newJob({ batchSize: 7 }).run(),
      newJob({ batchSize: 7 }).run(),
    ]);
    expect(results[0].purged + results[1].purged).toBe(30);
    expect(await count('audit_log')).toBe(30);
    expect(await overdueByOracle()).toBe(0);
  });
});

describe('M2-09 FR-31 after retention a transaction can no longer be reconciled', () => {
  it('M2-09 FR-31 TF-14 generate_from_transaction on a purged P2 row is TOKEN_NOT_FOUND, audited as a refusal', async () => {
    const tokens = new TokenService({
      operation: new AuditedOperation(db.app, new AuditWriter()),
      policy: new PolicyEngine({
        PAYMENT_PROCESSING: 900,
        FRAUD_DETECTION: 2_592_000,
        NOTIFICATION: 900,
        NOTIFICATION_REGISTRATION: 31_536_000,
        DAILY_RECONCILIATION: 86_400,
        INTERNAL_AUDIT: 600,
      }),
      index,
      cipher,
      mint: new TokenMint(keys),
      clock,
      graceSeconds: GRACE,
      keyVersion: 1,
    });
    const request = {
      requestingService: 'RECONCILIATION',
      transactionId: 'TX-9001',
      targetService: 'RECONCILIATION',
      purpose: 'DAILY_RECONCILIATION',
      subjectType: 'ACCOUNT',
    };
    await tokens.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'ACCOUNT',
      subjectId: '1234567801',
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId: 'TX-9001',
    });
    // Before retention the old transaction can still be reconciled.
    expect((await tokens.generateFromTransaction(request)).reused).toBe(false);

    clock.advance((RETENTION_DAYS + 2) * 86_400);
    await job.run();
    const outcome = await tokens.generateFromTransaction(request).catch((error: unknown) => error);
    expect((outcome as DomainError).reason).toBe('TOKEN_NOT_FOUND');
    expect((await reader.query({ status: 'DENIED' }))[0]).toMatchObject({
      action: 'GENERATE_TOKEN',
      reason: 'TOKEN_NOT_FOUND',
    });
  });
});

describe('M2-09 the job is configured at start', () => {
  it.each([
    ['retentionDays of zero', { retentionDays: 0 }],
    ['a negative retentionDays', { retentionDays: -1 }],
    ['a fractional retentionDays', { retentionDays: 1.5 }],
    ['a retentionDays that is not a number', { retentionDays: Number.NaN }],
    ['a string retentionDays', { retentionDays: '90' as never }],
    ['a negative grace', { graceSeconds: -1 }],
    ['a batchSize of zero', { batchSize: 0 }],
    ['a fractional batchSize', { batchSize: 2.5 }],
  ])('M2-09 refuses %s', (_name, over) => {
    expect(() => newJob(over)).toThrow(RangeError);
  });
});
