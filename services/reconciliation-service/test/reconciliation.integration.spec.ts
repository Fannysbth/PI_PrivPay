import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import {
  ReconciliationRepository,
  ReconciliationService,
  type ReportItem,
} from '../src/reconciliation';
import { A1, A3, FakePrivacy, FakeTransactions, PRD16_COMPLETED, recordingLogger } from './fakes';

// Seam: ReconciliationService (spec reconciliation 3.1, 3.2) on the real reconciliation database as the real runtime
// role, with the neighbours as doubles. Nothing sleeps; time moves only when a test moves the FakeClock.
// Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const DATE = '2026-10-05';

let db: TestDb;
let clock: FakeClock;
let transactions: FakeTransactions;
let privacy: FakePrivacy;
let log: ReturnType<typeof recordingLogger>;
let service: ReconciliationService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'reconciliation', suffix: 'm406' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-06T00:10:00.000Z');
  transactions = new FakeTransactions();
  privacy = new FakePrivacy();
  log = recordingLogger();
  service = new ReconciliationService({
    repository: new ReconciliationRepository(db.app),
    transactions,
    privacy,
    clock,
    logger: log.logger,
  });
  transactions.completed = PRD16_COMPLETED;
  privacy.tokens = new Map([
    ['TX-10001', A1],
    ['TX-10003', A3],
  ]);
});
afterEach(async () => {
  await db.close();
});

const REPORT: ReportItem[] = [
  { accountPseudonym: A1, amount: 35_000, bankReference: 'BNK-20261005-0001' },
  { accountPseudonym: A3, amount: 1_500_000, bankReference: 'BNK-20261005-0002' },
];
const reasonOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
};
const batches = async () =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM settlement_batches ORDER BY batch_id',
    )
  ).rows;
const itemRows = async () =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT account_pseudonym, amount, bank_reference, matched FROM settlement_items ORDER BY bank_reference',
    )
  ).rows;

describe('M4-06 TF-05 FR-41 C-10 the run of a day (D1 to D4)', () => {
  it('M4-06 TF-05 the two completed transactions of PRD 16 meet the two items: B-20261005, 2, 2, 0, MATCHED, 1.535.000', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    expect(await service.run(DATE)).toEqual({
      batch_id: 'B-20261005',
      tx_count: 2,
      matched: 2,
      unmatched: 0,
      status: 'MATCHED',
    });
    expect(transactions.dates).toEqual([DATE]);
    expect(await batches()).toMatchObject([
      { batch_id: 'B-20261005', tx_count: 2, total_amount: '1535000.00', status: 'MATCHED' },
    ]);
    expect((await itemRows()).map((row) => row['matched'])).toEqual([true, true]);
  });

  it('M4-06 TF-05 the token Privacy gives for the transaction (D2) is the token of the report (D3), or nothing pairs', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    privacy.tokens.set('TX-10001', 'PSEU-00000999');
    expect(await service.run(DATE)).toMatchObject({ matched: 1, unmatched: 2, status: 'PARTIAL' });
  });

  it('M4-06 TF-05 TOKEN_NOT_FOUND for one transaction counts it unmatched and does not stop the batch', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    privacy.tokens.set('TX-10001', null);
    expect(await service.run(DATE)).toEqual({
      batch_id: 'B-20261005',
      tx_count: 2,
      matched: 1,
      unmatched: 2,
      status: 'PARTIAL',
    });
    expect(log.entries.find((entry) => entry.event === 'account_token_missing')?.fields).toEqual({
      transaction_id: 'TX-10001',
    });
    expect(await itemRows()).toMatchObject([{ matched: false }, { matched: true }]);
  });

  it('M4-06 TF-16 an item without a transaction (the bank has one more) is PARTIAL', async () => {
    await service.receiveReport({
      batchDate: DATE,
      items: [
        ...REPORT,
        { accountPseudonym: 'PSEU-00000ABC', amount: 777_000, bankReference: 'BNK-20261005-0003' },
      ],
    });
    expect(await service.run(DATE)).toMatchObject({ matched: 2, unmatched: 1, status: 'PARTIAL' });
  });

  it('M4-06 K-22 nothing matches although both sides exist: MISMATCHED', async () => {
    await service.receiveReport({
      batchDate: DATE,
      items: [{ accountPseudonym: A1, amount: 36_000, bankReference: 'BNK-20261005-0001' }],
    });
    expect(await service.run(DATE)).toMatchObject({
      matched: 0,
      unmatched: 3,
      status: 'MISMATCHED',
    });
  });

  it('M4-06 K-22 no report for the date: the batch has no items and is counted by the same rule', async () => {
    expect(await service.run(DATE)).toMatchObject({
      tx_count: 2,
      matched: 0,
      unmatched: 2,
      status: 'MISMATCHED',
    });
    transactions.completed = [];
    expect(await service.run('2026-10-07')).toEqual({
      batch_id: 'B-20261007',
      tx_count: 0,
      matched: 0,
      unmatched: 0,
      status: 'MATCHED',
    });
  });

  it('M4-06 K-22 Transaction that cannot answer is SERVICE_UNAVAILABLE and no batch is made', async () => {
    transactions.fail = true;
    expect(await reasonOf(service.run(DATE))).toBe('SERVICE_UNAVAILABLE');
    expect(await batches()).toEqual([]);
    expect(privacy.asked).toEqual([]);
  });

  it('M4-06 K-22 Privacy that cannot answer is SERVICE_UNAVAILABLE and the batch is left as it was', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    privacy.fail = true;
    expect(await reasonOf(service.run(DATE))).toBe('SERVICE_UNAVAILABLE');
    expect(await batches()).toMatchObject([{ tx_count: 0, status: 'MISMATCHED' }]);
    expect((await itemRows()).map((row) => row['matched'])).toEqual([false, false]);
  });

  it('M4-06 K-22 running the same date again replaces the earlier run: one batch, flags and counts of the last', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    await service.run(DATE);
    transactions.completed = [PRD16_COMPLETED[0] as (typeof PRD16_COMPLETED)[number]];
    expect(await service.run(DATE)).toMatchObject({
      tx_count: 1,
      matched: 1,
      unmatched: 1,
      status: 'PARTIAL',
    });
    expect(await batches()).toMatchObject([
      { tx_count: 1, total_amount: '35000.00', status: 'PARTIAL' },
    ]);
    expect((await itemRows()).map((row) => row['matched'])).toEqual([true, false]);
  });

  it('M4-06 FR-32 nothing a run keeps is an account number: tokens, amounts, references and counts only', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    await service.run(DATE);
    const dump = JSON.stringify([await batches(), await itemRows()]);
    expect(dump).not.toMatch(/\b[0-9]{10,}\b/);
  });
});

describe('M4-06 K-22 K-05 one report per date', () => {
  it('M4-06 K-22 the first report is stored; the same content again is the same answer and stores nothing more', async () => {
    expect(await service.receiveReport({ batchDate: DATE, items: REPORT })).toEqual({
      created: true,
      batchDate: DATE,
      itemCount: 2,
    });
    expect(await service.receiveReport({ batchDate: DATE, items: [...REPORT].reverse() })).toEqual({
      created: false,
      batchDate: DATE,
      itemCount: 2,
    });
    expect(await itemRows()).toHaveLength(2);
  });

  it('M4-06 K-22 a different report for the same date is IDEMPOTENCY_CONFLICT and changes nothing', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    const changed = REPORT.map((item, index) => (index === 0 ? { ...item, amount: 36_000 } : item));
    expect(await reasonOf(service.receiveReport({ batchDate: DATE, items: changed }))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    const fewer = REPORT.slice(0, 1);
    expect(await reasonOf(service.receiveReport({ batchDate: DATE, items: fewer }))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    expect((await itemRows()).map((row) => row['amount'])).toEqual(['35000.00', '1500000.00']);
  });

  it('M4-06 K-22 a report that comes after a run without one is the first report, and the next run uses it', async () => {
    await service.run(DATE);
    expect(await service.receiveReport({ batchDate: DATE, items: REPORT })).toMatchObject({
      created: true,
    });
    expect(await service.run(DATE)).toMatchObject({ matched: 2, status: 'MATCHED' });
  });

  it('M4-06 K-22 a report after a run that used another report is still the same or a conflict, never a silent second one', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    await service.run(DATE);
    expect(await reasonOf(service.receiveReport({ batchDate: DATE, items: REPORT.slice(1) }))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('M4-06 K-22 reports for two dates are two batches', async () => {
    await service.receiveReport({ batchDate: DATE, items: REPORT });
    await service.receiveReport({ batchDate: '2026-10-06', items: REPORT });
    expect((await batches()).map((row) => row['batch_id'])).toEqual(['B-20261005', 'B-20261006']);
  });
});

describe('M4-06 K-22 two reports that arrive together', () => {
  it('M4-06 K-22 20 rounds of two different reports at once on a date a run already made: exactly one is stored', async () => {
    for (let round = 0; round < 20; round += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + round)).toISOString().slice(0, 10);
      // The batch exists but has no items, as after a run without a report: the case where only the row lock decides.
      transactions.completed = [];
      await service.run(date);
      const first = [{ accountPseudonym: A1, amount: 10_000, bankReference: 'BNK-A' }];
      const second = [
        { accountPseudonym: A3, amount: 20_000, bankReference: 'BNK-B' },
        { accountPseudonym: A3, amount: 30_000, bankReference: 'BNK-C' },
      ];
      const outcomes = await Promise.all(
        [first, second].map((items) => reasonOf(service.receiveReport({ batchDate: date, items }))),
      );
      expect(outcomes.filter((outcome) => outcome === 'no error')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'IDEMPOTENCY_CONFLICT')).toHaveLength(1);
      const stored = await db.owner.query<{ n: string }>(
        'SELECT count(*) AS n FROM settlement_items WHERE batch_id = $1',
        [`B-${date.replaceAll('-', '')}`],
      );
      expect([1, 2]).toContain(Number(stored.rows[0]?.n));
    }
  });

  it('M4-06 K-22 a report that has to wait for a run on its date is stored after the run, whole', async () => {
    await service.run(DATE);
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM settlement_batches WHERE batch_id = 'B-20261005' FOR UPDATE`,
      );
      const report = service.receiveReport({ batchDate: DATE, items: REPORT });
      // The report is queued on the row lock of the batch: seen in pg_locks, never slept for.
      const until = Date.now() + 20_000;
      let queued = false;
      while (Date.now() < until && !queued) {
        const { rows } = await db.owner.query(
          `SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`,
        );
        queued = rows.length > 0;
      }
      expect(queued).toBe(true);
      expect(await itemRows()).toEqual([]);
      await holder.query('COMMIT');
      expect(await report).toMatchObject({ created: true });
    } finally {
      holder.release();
    }
    expect(await itemRows()).toHaveLength(2);
  });
});
