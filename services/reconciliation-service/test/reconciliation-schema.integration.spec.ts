import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';

// Seam: the reconciliation-db after its migrations, seen through the real roles (the owner for inspection, the runtime
// role for what it may do). Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'reconciliation', suffix: 'm406s' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
});
afterEach(async () => {
  await db.close();
});

const sqlState = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};
const columns = async (table: string): Promise<string[]> =>
  (
    await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )
  ).rows.map((row) => row.column_name);

const batch = (date = '2026-10-05', status = 'MISMATCHED') =>
  db.app.query(
    `INSERT INTO settlement_batches (batch_id, batch_date, tx_count, total_amount, status)
     VALUES ('B-' || to_char($1::date, 'YYYYMMDD'), $1, 0, 0, $2)`,
    [date, status],
  );
const item = (over: Record<string, unknown> = {}) => {
  const row = {
    batch_id: 'B-20261005',
    account_pseudonym: 'PSEU-B80D2C4F',
    amount: 35000,
    bank_reference: 'BNK-20261005-0001',
    ...over,
  };
  return db.app.query(
    `INSERT INTO settlement_items (batch_id, account_pseudonym, amount, bank_reference)
     VALUES ($1, $2, $3, $4)`,
    Object.values(row),
  );
};

describe('M4-06 FR-32 S-38 T-14 the schema holds tokens and amounts, never an account number or an opened identity', () => {
  it('M4-06 FR-32 the tables have the columns of PRD 11 and nothing that could hold an account number', async () => {
    expect(await columns('settlement_batches')).toEqual([
      'batch_id',
      'batch_date',
      'tx_count',
      'total_amount',
      'status',
      'created_at',
    ]);
    expect(await columns('settlement_items')).toEqual([
      'id',
      'batch_id',
      'account_pseudonym',
      'amount',
      'bank_reference',
      'matched',
    ]);
    expect(await columns('audit_requests')).toEqual([
      'request_id',
      'transaction_id',
      'reason_code',
      'actor_id',
      'requested_at',
    ]);
  });

  it('M4-06 S-38 no column of the database could hold an identity value or the result of opening one', async () => {
    const found = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name IN ('settlement_batches', 'settlement_items', 'audit_requests')
          AND column_name ~* '(customer_id|subject|nik|nama|name|email|phone|hp|rekening|account_number|attribute|disclos)'`,
    );
    expect(found.rows.map((row) => row.column_name)).toEqual([]);
  });

  it('M4-06 FR-32 the database itself refuses an account number where a token belongs', async () => {
    await batch();
    expect(await sqlState(item({ account_pseudonym: '1234567801' }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(item({ account_pseudonym: 'pseu-b80d2c4f' }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(item())).toBeUndefined();
  });
});

describe('M4-06 K-04 K-05 the database refuses values outside the lists', () => {
  it('M4-06 K-22 a status outside the three, or a batch id that is not the date, is refused', async () => {
    expect(await sqlState(batch('2026-10-05', 'PENDING'))).toBe(CHECK_VIOLATION);
    expect(
      await sqlState(
        db.app.query(
          `INSERT INTO settlement_batches VALUES ('B-20261006', '2026-10-05', 0, 0, 'MATCHED', now())`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('M4-06 K-05 the same bank reference twice in one batch is refused, in another batch it is not', async () => {
    await batch('2026-10-05');
    await batch('2026-10-06');
    await item();
    expect(await sqlState(item())).toBe(UNIQUE_VIOLATION);
    expect(await sqlState(item({ batch_id: 'B-20261006' }))).toBeUndefined();
  });

  it('M4-06 K-22 there is one batch per date', async () => {
    await batch();
    expect(await sqlState(batch())).toBe(UNIQUE_VIOLATION);
  });

  it('M4-06 an amount under one is refused', async () => {
    await batch();
    expect(await sqlState(item({ amount: 0 }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(item({ amount: -5 }))).toBe(CHECK_VIOLATION);
  });

  it('M4-07 E1 an audit request has only a coded reason, from the three', async () => {
    const insert = (reason: string) =>
      db.app.query(
        `INSERT INTO audit_requests (transaction_id, reason_code, actor_id) VALUES ('TX-1', $1, 'usr-auditor')`,
        [reason],
      );
    expect(await sqlState(insert('A free text reason'))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert('DISPUTE'))).toBeUndefined();
  });
});

describe('M4-06 NFR-09 the runtime role has the least privilege', () => {
  it('M4-06 NFR-09 the runtime role cannot delete, alter or drop; an audit request it cannot even read', async () => {
    await batch();
    await item();
    for (const table of ['settlement_batches', 'settlement_items']) {
      expect(await sqlState(db.app.query(`DELETE FROM ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(db.app.query(`TRUNCATE ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await sqlState(db.app.query('ALTER TABLE settlement_items ADD COLUMN nik TEXT'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('DROP TABLE settlement_items'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    await db.app.query(
      `INSERT INTO audit_requests (transaction_id, reason_code, actor_id) VALUES ('TX-1', 'OTHER', 'usr-auditor')`,
    );
    expect(await sqlState(db.app.query('SELECT * FROM audit_requests'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await sqlState(db.app.query('UPDATE audit_requests SET reason_code = $1', ['OTHER'])),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.app.query('DELETE FROM audit_requests'))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
