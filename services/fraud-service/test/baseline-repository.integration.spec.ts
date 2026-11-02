import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { compareSchemas } from '../../../tests/baseline/schema-parity';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { baselineAssessmentRepository } from '../src/baseline';
import { proposedAssessmentRepository } from '../src/proposed';
import { FraudAssessor, RiskEngine, type RiskConfig } from '../src/risk';

// Seam: the baseline fraud-db and its repository under the same FraudAssessor, as the real runtime role (ADR-0006,
// M5-01). The baseline keys the history by customer_id, so identities here are canaries.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const RISK: RiskConfig = {
  amountThreshold: 1_000_000,
  oddHourStart: 22,
  oddHourEnd: 6,
  holdThreshold: 50,
  blockThreshold: 90,
};
const person = buildCanary(52);

let db: TestDb;
let other: TestDb | undefined;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'fraud', suffix: 'm501b' });
  await migrate(db.owner, { root: migrations, mode: 'baseline' });
});
afterEach(async () => {
  await db.close();
  await other?.close();
  other = undefined;
});

const assessorOver = (
  repository: ReturnType<typeof baselineAssessmentRepository>,
  clock = new FakeClock('2026-10-23T08:00:00.000Z'),
) =>
  new FraudAssessor({
    repository,
    engine: new RiskEngine(),
    config: RISK,
    historyDays: 30,
    clock,
  });

describe('M5-01 FR-23 the baseline fraud schema keys the history by customer_id', () => {
  it('M5-01 FR-23 fraud_assessments has customer_id and no pseudonym column', async () => {
    const found = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fraud_assessments'`,
    );
    const names = found.rows.map((row) => row.column_name);
    expect(names).toContain('customer_id');
    expect(names.filter((name) => name.includes('pseudonym'))).toEqual([]);
  });

  // Changed with the owner's decision on Tabel IV (G3, G6): baseline also keeps nik, nama and account_number, so they
  // are the only columns it adds; before, the report had to be empty.
  it('M5-01 FR-23 G6 apart from the identity column and the three copied attributes the schema, the rules and the grants are those of proposed', async () => {
    other = await createTestDb(config, { service: 'fraud', suffix: 'm501p' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    const report = await compareSchemas(
      other.owner,
      db.owner,
      { 'fraud_assessments.pseudonym': 'fraud_assessments.customer_id' },
      { proposed: 'privpay_fraud_app', baseline: 'privpay_fraud_app' },
    );
    expect(report).toEqual({
      missing: [
        'baseline adds fraud_assessments.nik',
        'baseline adds fraud_assessments.nama',
        'baseline adds fraud_assessments.account_number',
      ],
      different: [],
      indexes: [],
      grants: [],
    });
    const rules = (db: TestDb) => db.owner.query('SELECT * FROM risk_rules ORDER BY rule');
    expect((await rules(db)).rows).toEqual((await rules(other)).rows);
  });

  it('M5-01 NFR-09 assessments stay append-only for the runtime role', async () => {
    await expect(db.app.query('UPDATE fraud_assessments SET amount = 1')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('M5-01 FR-23 the same FraudAssessor over the baseline repository', () => {
  it('M5-01 FR-23 US-04 the second assessment of a customer uses the first: prior_count 1, score 75, as in proposed', async () => {
    const assessor = assessorOver(baselineAssessmentRepository('baseline', db.app));
    await assessor.assess({
      pseudonym: person.customer_id,
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    const second = await assessor.assess({
      pseudonym: person.customer_id,
      amount: 7_000_000,
      txHour: 23,
      geohash: 'wxyz1',
    });
    expect(second).toMatchObject({
      riskScore: 75,
      decision: 'HOLD_FOR_VERIFICATION',
      priorCount: 1,
    });
    const stored = await db.owner.query('SELECT customer_id FROM fraud_assessments');
    expect(stored.rows).toEqual([
      { customer_id: person.customer_id },
      { customer_id: person.customer_id },
    ]);
  });

  it('M5-01 FR-23 the history of one customer is not that of another', async () => {
    const assessor = assessorOver(baselineAssessmentRepository('baseline', db.app));
    await assessor.assess({
      pseudonym: person.customer_id,
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    const stranger = await assessor.assess({
      pseudonym: 'CUST-000102',
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    expect(stranger.priorCount).toBe(0);
  });

  it('M5-01 ADR-0006 refuses to be built in the proposed mode', () => {
    expect(() => baselineAssessmentRepository('proposed', db.app)).toThrow(/PRIVACY_MODE=baseline/);
  });
});

describe('M5-01 NFR-15 the positive control: in baseline the scanner finds the real data', () => {
  it('M5-01 NFR-15 FR-23 the canary customer_id is found in the dump, and not in proposed', async () => {
    await assessorOver(baselineAssessmentRepository('baseline', db.app)).assess({
      pseudonym: person.customer_id,
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    const found = await scanDatabase(db.owner, [person], 'fraud');
    expect(found.map((finding) => finding.location)).toContain('fraud_assessments.customer_id');

    other = await createTestDb(config, { service: 'fraud', suffix: 'm501q' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    await assessorOver(proposedAssessmentRepository(other.app)).assess({
      pseudonym: 'PSEU-7BCD04F2',
      amount: 2_000_000,
      txHour: 13,
      geohash: 'qqgu7',
    });
    expect(await scanDatabase(other.owner, [person], 'fraud')).toEqual([]);
  });
});

describe('N-45 FRAUD_HISTORY_DAYS the history is the last 30 days, in baseline as in proposed', () => {
  const DAY = 86_400;
  const first = { pseudonym: person.customer_id, amount: 100_000, txHour: 13, geohash: 'qqgu7' };
  const start = () => {
    const clock = new FakeClock('2026-10-23T08:00:00.000Z');
    return {
      clock,
      assessor: assessorOver(baselineAssessmentRepository('baseline', db.app), clock),
    };
  };

  it('N-45 an assessment exactly 30 days old still counts (baseline)', async () => {
    const { clock, assessor } = start();
    await assessor.assess(first);
    clock.advance(30 * DAY);
    expect((await assessor.assess(first)).priorCount).toBe(1);
  });

  it('N-45 an assessment 30 days and a second old no longer counts: a cold start again (baseline)', async () => {
    const { clock, assessor } = start();
    await assessor.assess(first);
    clock.advance(30 * DAY + 1);
    const result = await assessor.assess(first);
    expect(result.priorCount).toBe(0);
    expect([...result.rulesSkipped].sort()).toEqual([
      'AMOUNT_OVER_3X_AVG',
      'NEW_LOCATION_VS_LAST_3',
    ]);
  });
});
