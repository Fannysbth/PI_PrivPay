import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AssessmentRepository, FraudAssessor, RiskEngine, type RiskConfig } from '../src/risk';

// Seam: FraudAssessor.assess (POST /fraud/assess without HTTP, spec fraud 3 and 4) on the real fraud database, as the
// real runtime role, with a FakeClock. The pseudonyms are invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const RISK: RiskConfig = {
  amountThreshold: 1_000_000,
  oddHourStart: 22,
  oddHourEnd: 6,
  holdThreshold: 50,
  blockThreshold: 90,
};
const FRAUD_TOKEN = ['PSEU', '7BCD04F2'].join('-');

let db: TestDb;
let clock: FakeClock;
let assessor: FraudAssessor;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'fraud', suffix: 'm404' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  assessor = new FraudAssessor({
    repository: new AssessmentRepository(db.app),
    engine: new RiskEngine(),
    config: RISK,
    clock,
  });
});
afterEach(async () => {
  await db.close();
});

const rows = async (sql = 'SELECT * FROM fraud_assessments ORDER BY assessed_at, id') =>
  (await db.owner.query<Record<string, unknown>>(sql)).rows;

describe('M4-04 FR-18 TF-12 US-04 the history of a token', () => {
  it('M4-04 TF-12 the first assessment is a cold start: score 10, two rules skipped, one row with prior_count 0', async () => {
    const result = await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    expect(result).toMatchObject({
      riskScore: 10,
      decision: 'ALLOW',
      rulesFired: ['AMOUNT_OVER_THRESHOLD'],
      priorCount: 0,
    });
    expect([...result.rulesSkipped].sort()).toEqual([
      'AMOUNT_OVER_3X_AVG',
      'NEW_LOCATION_VS_LAST_3',
    ]);
    const [row] = await rows();
    expect(row).toMatchObject({
      pseudonym: FRAUD_TOKEN,
      amount: '2000000.00',
      tx_hour: 13,
      geohash: 'qqgu7',
      prior_count: 0,
      avg_prior_amount: null,
      risk_score: '10.00',
      decision: 'ALLOW',
      rules_fired: ['AMOUNT_OVER_THRESHOLD'],
    });
    expect(row?.['assessed_at']).toEqual(clock.now());
  });

  it('M4-04 TF-12 US-04 the second assessment uses the first: prior_count 1, score 75 (10 + 25 + 20 + 20), HOLD_FOR_VERIFICATION', async () => {
    await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    clock.advance(3600);
    const second = await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 8_000_000,
      txHour: 2,
      geohash: 'qqt8h',
    });
    expect(second).toMatchObject({
      riskScore: 75,
      decision: 'HOLD_FOR_VERIFICATION',
      priorCount: 1,
      rulesSkipped: [],
    });
    expect([...second.rulesFired].sort()).toEqual([
      'AMOUNT_OVER_3X_AVG',
      'AMOUNT_OVER_THRESHOLD',
      'NEW_LOCATION_VS_LAST_3',
      'ODD_HOUR_OUTSIDE_06_22',
    ]);
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({
      prior_count: 1,
      avg_prior_amount: '2000000.00',
      risk_score: '75.00',
    });
  });

  it('M4-04 FR-18 the history of another token is not the history of this one', async () => {
    await assessor.assess({
      pseudonym: 'PSEU-AAAAAAA1',
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    clock.advance(60);
    const other = await assessor.assess({
      pseudonym: 'PSEU-AAAAAAA2',
      amount: 8_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    expect(other.priorCount).toBe(0);
  });

  it('M4-04 FR-37 the three latest places are the newest by time, whatever the order they were written in', async () => {
    for (const [hash, minutes] of [
      ['aaaaa', 0],
      ['bbbbb', 1],
      ['ccccc', 2],
      ['ddddd', 3],
    ] as const) {
      clock.set(new Date(Date.parse('2026-10-20T08:00:00.000Z') + minutes * 60_000));
      await assessor.assess({ pseudonym: FRAUD_TOKEN, amount: 10, txHour: 12, geohash: hash });
    }
    clock.advance(3600);
    const known = await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 10,
      txHour: 12,
      geohash: 'bbbbb',
    });
    clock.advance(60);
    const old = await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 10,
      txHour: 12,
      geohash: 'aaaaa',
    });
    // After the fifth assessment the three newest are bbbbb, ccccc, ddddd: aaaaa is new again.
    expect(known.rulesFired).not.toContain('NEW_LOCATION_VS_LAST_3');
    expect(old.rulesFired).toContain('NEW_LOCATION_VS_LAST_3');
  });

  it('M4-04 FR-37 two assessments of one token at the same time are both written (append-only)', async () => {
    await Promise.all([
      assessor.assess({ pseudonym: FRAUD_TOKEN, amount: 2_000_000, txHour: 13, geohash: 'qqgu7' }),
      assessor.assess({ pseudonym: FRAUD_TOKEN, amount: 2_000_000, txHour: 13, geohash: 'qqgu7' }),
    ]);
    expect(await rows()).toHaveLength(2);
  });
});

describe('M4-04 K-20 the rules are read from the table at run time', () => {
  it('M4-04 K-20 a changed weight counts at the next assessment', async () => {
    await db.owner.query(`UPDATE risk_rules SET weight = 40 WHERE rule = 'AMOUNT_OVER_THRESHOLD'`);
    const result = await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    expect(result.riskScore).toBe(40);
  });

  it('M4-04 K-20 a rule switched off is skipped, adds nothing and is told', async () => {
    await db.owner.query(
      `UPDATE risk_rules SET active = false WHERE rule = 'AMOUNT_OVER_THRESHOLD'`,
    );
    const result = await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    expect(result.riskScore).toBe(0);
    expect(result.rulesSkipped).toContain('AMOUNT_OVER_THRESHOLD');
    expect((await rows())[0]?.['rules_fired']).toEqual([]);
  });

  it('M4-04 K-20 a multiplier changed in the table counts', async () => {
    await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 1_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    clock.advance(60);
    await db.owner.query(
      `UPDATE risk_rules SET parameter = '2.00' WHERE rule = 'AMOUNT_OVER_3X_AVG'`,
    );
    const result = await assessor.assess({
      pseudonym: FRAUD_TOKEN,
      amount: 2_500_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    expect(result.rulesFired).toContain('AMOUNT_OVER_3X_AVG');
  });
});
