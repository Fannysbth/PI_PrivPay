import { join } from 'node:path';
import { DomainError, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import type { Pool } from 'pg';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import {
  AuditReader,
  AuditWriter,
  AuditedOperation,
  DeniedOperation,
  type AuditEntry,
  type SuccessEntry,
} from '../src/audit';

// Seam: AuditWriter, AuditReader and AuditedOperation on the real privacy database, each pool connected as its real
// role (privpay_app writes, privpay_auditor reads). Failures in the middle of an operation are real database errors,
// not mocks (qa-checklist). Needs PostgreSQL and scripts/db/bootstrap.ps1. Every value below is invented.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

let db: TestDb;
let operation: AuditedOperation;
let reader: AuditReader;
let auditorPool: Pool;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm204' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  auditorPool = db.auditor;
  operation = new AuditedOperation(db.app, new AuditWriter());
  reader = new AuditReader(auditorPool);
});
afterEach(async () => {
  await db.close();
});

const SUCCESS_ENTRY: SuccessEntry = {
  action: 'GENERATE_TOKEN',
  status: 'SUCCESS',
  reason: 'OK',
  requestingService: 'API_GATEWAY',
  pseudonym: 'PSEU-00000001',
  purpose: 'PAYMENT',
  transactionId: 'TX-9001',
  keyVersion: 1,
};

/** The state change the operations below make: a row that only the same transaction may keep or lose. */
const setStatus = (
  tx: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  id: string,
) =>
  tx.query("INSERT INTO transaction_status (transaction_id, status) VALUES ($1, 'PENDING')", [id]);

const stateCount = async (): Promise<number> => {
  const { rows } = await db.owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM transaction_status',
  );
  return Number(rows[0]?.n);
};
const auditCount = async (): Promise<number> => {
  const { rows } = await db.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit_log');
  return Number(rows[0]?.n);
};

describe('M2-04 FR-13 a successful operation', () => {
  it('M2-04 FR-13 writes its state change and exactly one SUCCESS audit row in one transaction', async () => {
    const result = await operation.run(async (tx) => {
      await setStatus(tx, 'TX-TEST-0001');
      return { result: 'done', audit: SUCCESS_ENTRY };
    });
    expect(result).toBe('done');
    expect(await stateCount()).toBe(1);
    expect(await auditCount()).toBe(1);
  });

  it('M2-04 FR-13 the auditor pool reads the row back without the writer ever selecting it', async () => {
    await operation.run(async (tx) => {
      await setStatus(tx, 'TX-TEST-0001');
      return { result: null, audit: { ...SUCCESS_ENTRY, attributeNames: ['nik', 'nama'] } };
    });
    const rows = await reader.query({ pseudonym: 'PSEU-00000001' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'GENERATE_TOKEN',
      status: 'SUCCESS',
      reason: 'OK',
      requestingService: 'API_GATEWAY',
      purpose: 'PAYMENT',
      transactionId: 'TX-9001',
      attributeNames: ['nik', 'nama'],
      keyVersion: 1,
    });
  });
});

describe('M2-04 FR-13 a failure in the middle of an operation', () => {
  it('M2-04 FR-13 an audit row the database refuses takes the state change down with it', async () => {
    // 'hp' is not an attribute name: chk_attribute_names refuses the audit row after the state change was written.
    const bad = { ...SUCCESS_ENTRY, attributeNames: ['hp'] } as unknown as SuccessEntry;
    const outcome = operation.run(async (tx) => {
      await setStatus(tx, 'TX-TEST-0002');
      return { result: 'done', audit: bad };
    });
    await expect(outcome).rejects.toMatchObject({
      reason: 'INTERNAL_ERROR',
      cause: 'audit_write:23514',
    });
    await expect(outcome).rejects.toBeInstanceOf(DomainError);
    expect(await stateCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('M2-04 FR-15 an entry with a malformed field is refused before writing, state and audit both absent', async () => {
    const bad = { ...SUCCESS_ENTRY, actorId: 'budi.example@example.test' };
    const outcome = operation.run(async (tx) => {
      await setStatus(tx, 'TX-TEST-0006');
      return { result: 'done', audit: bad };
    });
    await expect(outcome).rejects.toMatchObject({
      reason: 'INTERNAL_ERROR',
      cause: 'audit_write:invalid_entry',
    });
    expect(await stateCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('M2-04 FR-13 a commit the database refuses after the audit row was written takes the audit row down too', async () => {
    // A deferred trigger fails only at COMMIT, when the state change and the audit row are already in the transaction.
    await db.owner.query(`
      CREATE FUNCTION refuse_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
      CREATE CONSTRAINT TRIGGER refuse_commit AFTER INSERT ON transaction_status
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_at_commit();`);
    const outcome = operation.run(async (tx) => {
      await setStatus(tx, 'TX-TEST-0005');
      return { result: 'done', audit: SUCCESS_ENTRY };
    });
    await expect(outcome).rejects.toMatchObject({
      reason: 'INTERNAL_ERROR',
      cause: 'commit:P0001',
    });
    expect(await stateCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('M2-04 FR-13 an unexpected error after the state change leaves no state and no audit row', async () => {
    const outcome = operation.run(async (tx) => {
      await setStatus(tx, 'TX-TEST-0003');
      throw new Error('boom');
    });
    await expect(outcome).rejects.toThrow('boom');
    expect(await stateCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('M2-04 FR-13 a denial rolls the state back and writes exactly one DENIED row of its own', async () => {
    const denied: AuditEntry = {
      ...SUCCESS_ENTRY,
      action: 'EXCHANGE_TOKEN',
      status: 'DENIED',
      reason: 'SERVICE_MISMATCH',
    };
    const outcome = operation.run(async (tx) => {
      await setStatus(tx, 'TX-TEST-0004');
      throw new DeniedOperation(denied);
    });
    await expect(outcome).rejects.toMatchObject({ reason: 'SERVICE_MISMATCH' });
    expect(await stateCount()).toBe(0);
    expect(await auditCount()).toBe(1);
    const rows = await reader.query({ status: 'DENIED' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'EXCHANGE_TOKEN', reason: 'SERVICE_MISMATCH' });
  });

  it('M2-04 FR-13 a DENIED row the database refuses makes the operation fail, not silently deny', async () => {
    const bad = {
      ...SUCCESS_ENTRY,
      status: 'DENIED',
      reason: 'SERVICE_MISMATCH',
      attributeNames: ['hp'],
    } as unknown as AuditEntry;
    const outcome = operation.run(() => Promise.reject(new DeniedOperation(bad)));
    await expect(outcome).rejects.toMatchObject({ reason: 'INTERNAL_ERROR' });
    expect(await auditCount()).toBe(0);
  });
});

describe('M2-04 TK-10 the two pools keep their roles', () => {
  it('M2-04 TK-10 AuditWriter on the auditor pool is refused by the database (42501)', async () => {
    const wrong = new AuditedOperation(auditorPool, new AuditWriter());
    await expect(
      wrong.run(() => Promise.resolve({ result: null, audit: SUCCESS_ENTRY })),
    ).rejects.toMatchObject({ reason: 'INTERNAL_ERROR', cause: 'audit_write:42501' });
    expect(await auditCount()).toBe(0);
  });

  it('M2-04 TK-10 AuditReader on the app pool is refused by the database (42501)', async () => {
    const wrong = new AuditReader(db.app);
    await expect(wrong.query({})).rejects.toMatchObject({ code: '42501' });
  });
});

describe('M2-04 FR-13 the reader filters and orders', () => {
  it('M2-04 FR-13 returns the newest rows first and honours action, status and limit', async () => {
    for (const [i, action] of (
      ['GENERATE_TOKEN', 'EXCHANGE_TOKEN', 'GENERATE_TOKEN'] as const
    ).entries()) {
      const id = `TX-91${String(i)}`;
      await operation.run(async (tx) => {
        await setStatus(tx, id);
        return {
          result: null,
          audit: { ...SUCCESS_ENTRY, action, transactionId: id },
        };
      });
    }
    expect((await reader.query({ action: 'GENERATE_TOKEN' })).map((r) => r.transactionId)).toEqual([
      'TX-912',
      'TX-910',
    ]);
    expect(await reader.query({ limit: 1 })).toHaveLength(1);
    expect(await reader.query({ status: 'DENIED' })).toHaveLength(0);
  });
});
