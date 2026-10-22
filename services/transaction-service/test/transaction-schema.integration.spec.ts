import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';

// Seam: the transaction-db after its migrations, seen through the real roles (the owner for inspection, the runtime
// role for what it may do). Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm401s' });
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
const insert = (over: Record<string, unknown> = {}) => {
  const row = {
    transaction_id: 'TX-1',
    idempotency_key: ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-'),
    customer_pseudonym: 'PSEU-00000001',
    account_pseudonym: 'PSEU-00000002',
    merchant_id: 'MRC-001',
    amount: 35000,
    geohash: 'qqgu4',
    status: 'PENDING',
    fraud_decision: null,
    ...over,
  };
  return db.app.query(
    `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym, merchant_id,
        amount, geohash, status, fraud_decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    Object.values(row),
  );
};

describe('M4-01 FR-16 S-38 the schema holds tokens and attributes, never an identity', () => {
  it('M4-01 FR-16 S-38 transactions has exactly the columns of PRD 11 plus privacy_synced_at (a time, gate 2 decision 1): no identity, no fraud_token, no notif_token', async () => {
    expect(await columns('transactions')).toEqual([
      'transaction_id',
      'idempotency_key',
      'customer_pseudonym',
      'account_pseudonym',
      'merchant_id',
      'amount',
      'geohash',
      'status',
      'risk_score',
      'fraud_decision',
      'reviewed_by',
      'reviewed_at',
      'created_at',
      'completed_at',
      'privacy_synced_at',
    ]);
  });

  it('M4-01 S-38 no table of the database has a column that could hold an identity value', async () => {
    const found = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
          AND column_name ~* '(customer_id|subject|nik|nama|name_|email|phone|hp|rekening|account_number|fraud_token|notif_token)'`,
    );
    // merchants.name is the name of a shop, not of a person.
    expect(found.rows.map((row) => row.column_name)).toEqual([]);
  });

  it('M4-01 the three merchants of PRD 16 are the only seed', async () => {
    const merchants = await db.owner.query(
      'SELECT merchant_id FROM merchants ORDER BY merchant_id',
    );
    expect(merchants.rows.map((row) => (row as { merchant_id: string }).merchant_id)).toEqual([
      'MRC-001',
      'MRC-002',
      'MRC-003',
    ]);
    expect((await db.owner.query('SELECT 1 FROM transactions')).rowCount).toBe(0);
  });
});

describe('M4-01 K-04 the database refuses values outside the lists', () => {
  it('M4-01 K-04 a status or a fraud decision outside its list is refused', async () => {
    expect(await sqlState(insert({ status: 'BOGUS' }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert({ fraud_decision: 'MAYBE' }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert({ status: 'HELD', fraud_decision: 'FRAUD_UNAVAILABLE' }))).toBe(
      undefined,
    );
  });

  it('M4-01 NFR-23 a second row with the same idempotency_key is refused by the database', async () => {
    await insert();
    expect(await sqlState(insert({ transaction_id: 'TX-2' }))).toBe('23505');
  });
});

describe('M4-01 NFR-09 the runtime role has the least privilege', () => {
  it('M4-01 NFR-09 the runtime role cannot delete, alter or drop, and cannot change the merchants', async () => {
    await insert();
    expect(await sqlState(db.app.query('DELETE FROM transactions'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.app.query('TRUNCATE transactions'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.app.query('ALTER TABLE transactions ADD COLUMN nik TEXT'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('DROP TABLE transactions'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.app.query(`UPDATE merchants SET name = 'x'`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query(`INSERT INTO merchants VALUES ('M', 'n', 'c', 'q')`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
