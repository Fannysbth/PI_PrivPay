import { join } from 'node:path';
import { createPool, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';

// Seam: the fraud-db after its migrations, seen through the real roles. Needs PostgreSQL and
// scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const INSUFFICIENT_PRIVILEGE = '42501';

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'fraud', suffix: 'm404s' });
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
const insert = () =>
  db.app.query(
    `INSERT INTO fraud_assessments (pseudonym, amount, tx_hour, geohash, prior_count, risk_score, decision)
     VALUES ('PSEU-00000001', 2000000, 13, 'qqgu7', 0, 10, 'ALLOW')`,
  );

describe('M4-04 FR-18 S-38 the schema holds a token and numbers, never an identity or a transaction', () => {
  it('M4-04 FR-18 fraud_assessments has exactly the columns of PRD 11: no identity, no transaction_id', async () => {
    expect(await columns('fraud_assessments')).toEqual([
      'id',
      'pseudonym',
      'amount',
      'tx_hour',
      'geohash',
      'prior_count',
      'avg_prior_amount',
      'risk_score',
      'decision',
      'rules_fired',
      'assessed_at',
    ]);
    expect(await columns('risk_rules')).toEqual(['rule', 'parameter', 'weight', 'active']);
  });

  it('M4-04 S-38 no column of the database could hold an identity or point at a transaction', async () => {
    const found = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
          AND column_name ~* '(customer_id|subject|nik|nama|name_|email|phone|hp|rekening|account|transaction|fraud_token|notif_token)'`,
    );
    expect(found.rows.map((row) => row.column_name)).toEqual([]);
  });

  it('M4-04 FR-18 S-71 the database of another service cannot be joined: its runtime role is refused here', async () => {
    const other = createPool(config, {
      role: 'privpay_transaction_app',
      database: db.database,
      max: 1,
    });
    try {
      expect(await sqlState(other.query('SELECT 1'))).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await other.end();
    }
    expect(await sqlState(db.app.query('SELECT * FROM transactions'))).toBe('42P01');
  });
});

describe('M4-04 K-20 the rule table is a policy table with the seed of PRD 10', () => {
  it('M4-04 K-20 four rules with their weights are seeded, all active, and nothing else', async () => {
    const rules = await db.owner.query<{ rule: string; weight: number; active: boolean }>(
      'SELECT rule, weight, active FROM risk_rules ORDER BY rule',
    );
    expect(rules.rows).toEqual([
      { rule: 'AMOUNT_OVER_3X_AVG', weight: 25, active: true },
      { rule: 'AMOUNT_OVER_THRESHOLD', weight: 10, active: true },
      { rule: 'NEW_LOCATION_VS_LAST_3', weight: 20, active: true },
      { rule: 'ODD_HOUR_OUTSIDE_06_22', weight: 20, active: true },
    ]);
    expect((await db.owner.query('SELECT 1 FROM fraud_assessments')).rowCount).toBe(0);
  });
});

describe('M4-04 NFR-09 the runtime role has the least privilege', () => {
  it('M4-04 NFR-09 it can add and read assessments, but never change, remove or drop one', async () => {
    await insert();
    expect((await db.app.query('SELECT 1 FROM fraud_assessments')).rowCount).toBe(1);
    expect(await sqlState(db.app.query(`UPDATE fraud_assessments SET risk_score = 0`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('DELETE FROM fraud_assessments'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('TRUNCATE fraud_assessments'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.app.query('DROP TABLE fraud_assessments'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('M4-04 NFR-09 it reads the rules but cannot change them', async () => {
    expect((await db.app.query('SELECT 1 FROM risk_rules')).rowCount).toBe(4);
    expect(await sqlState(db.app.query('UPDATE risk_rules SET weight = 0'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query(`INSERT INTO risk_rules VALUES ('X', '', 1, true)`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('DELETE FROM risk_rules'))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
