import { proposedTransactionRepository } from '../src/proposed';
import { join } from 'node:path';
import { FakeClock, FakeDelay, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { PendingSweeper, TransactionProcessor, type TransactionRequest } from '../src/transaction';
import { FakeFraud, FakeNotifications, FakePrivacy, FakeSubjects, recordingLogger } from './fakes';

// Seam: PendingSweeper.sweep (spec transaction 5 step 6, FR-39, TF-17) with the clock injected, on the real transaction
// database. Nothing sleeps: time moves only when the test moves the FakeClock. Needs PostgreSQL and bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const TIMEOUT_SECONDS = 300;

let db: TestDb;
let clock: FakeClock;
let privacy: FakePrivacy;
let log: ReturnType<typeof recordingLogger>;
let sweeper: PendingSweeper;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm403s' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T10:00:00.000Z');
  privacy = new FakePrivacy();
  log = recordingLogger();
  sweeper = new PendingSweeper({
    repository: proposedTransactionRepository(db.app),
    clock,
    privacy,
    timeoutSeconds: TIMEOUT_SECONDS,
    logger: log.logger,
  });
});
afterEach(async () => {
  await db.close();
});

let sequence = 0;
async function seed(status: string, ageSeconds: number): Promise<string> {
  sequence += 1;
  const id = `TX-${String(5_000 + sequence)}`;
  const createdAt = new Date(clock.now().getTime() - ageSeconds * 1000);
  await db.owner.query(
    `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
        merchant_id, amount, geohash, status, created_at)
      VALUES ($1, $2, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', 35000, 'qqgu4', $3, $4)`,
    [
      id,
      ['00000000', '0000', '4000', '8000', String(sequence).padStart(12, '0')].join('-'),
      status,
      createdAt,
    ],
  );
  return id;
}
const statusOf = async (id: string): Promise<string | undefined> =>
  (
    await db.owner.query<{ status: string }>(
      'SELECT status FROM transactions WHERE transaction_id = $1',
      [id],
    )
  ).rows[0]?.status;

describe('M4-03 FR-39 TF-17 the PENDING sweeper', () => {
  it('M4-03 TF-17 fails a PENDING row older than the timeout and tells Privacy FAILED', async () => {
    const stuck = await seed('PENDING', TIMEOUT_SECONDS + 1);
    expect(await sweeper.sweep()).toBe(1);
    expect(await statusOf(stuck)).toBe('FAILED');
    expect(privacy.patches).toEqual([{ transactionId: stuck, status: 'FAILED' }]);
    const [row] = (await db.owner.query<Record<string, unknown>>('SELECT * FROM transactions'))
      .rows;
    expect(row).toMatchObject({ fraud_decision: null, completed_at: null, reviewed_by: null });
  });

  it('M4-03 TF-17 the boundary is exact: at the timeout the row is left alone, one second later it is not', async () => {
    const edge = await seed('PENDING', TIMEOUT_SECONDS);
    expect(await sweeper.sweep()).toBe(0);
    expect(await statusOf(edge)).toBe('PENDING');
    clock.advance(1);
    expect(await sweeper.sweep()).toBe(1);
    expect(await statusOf(edge)).toBe('FAILED');
  });

  it('M4-03 TF-17 touches nothing but stuck PENDING rows: young PENDING, HELD, COMPLETED and FAILED stay as they are', async () => {
    const young = await seed('PENDING', 10);
    const held = await seed('HELD', 10_000);
    const done = await seed('COMPLETED', 10_000);
    const failed = await seed('FAILED', 10_000);
    const stuck = await seed('PENDING', 10_000);
    expect(await sweeper.sweep()).toBe(1);
    expect(await statusOf(young)).toBe('PENDING');
    expect(await statusOf(held)).toBe('HELD');
    expect(await statusOf(done)).toBe('COMPLETED');
    expect(await statusOf(failed)).toBe('FAILED');
    expect(await statusOf(stuck)).toBe('FAILED');
    expect(privacy.patches.map((p) => p.transactionId)).toEqual([stuck]);
  });

  it('M4-03 TF-17 a second run finds nothing: a swept row is not swept or announced twice', async () => {
    await seed('PENDING', 10_000);
    expect(await sweeper.sweep()).toBe(1);
    expect(await sweeper.sweep()).toBe(0);
    expect(privacy.patches).toHaveLength(1);
  });

  it('M4-03 FR-39 Privacy away keeps the row FAILED here and logs the id only (best effort)', async () => {
    const stuck = await seed('PENDING', 10_000);
    privacy.fail = true;
    expect(await sweeper.sweep()).toBe(1);
    expect(await statusOf(stuck)).toBe('FAILED');
    expect(log.entries).toEqual([
      {
        level: 'warn',
        event: 'status_patch_failed',
        fields: { transaction_id: stuck, reason: 'SERVICE_UNAVAILABLE' },
      },
    ]);
  });

  it('M4-03 TF-17 a winner still working inside the window is not disturbed: it finishes as COMPLETED', async () => {
    const request: TransactionRequest = {
      transactionId: 'TX-6001',
      idempotencyKey: ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-'),
      customerSubjectRef: 'PSEU-00000001',
      accountSubjectRef: 'PSEU-00000002',
      merchantId: 'MRC-001',
      amount: 2_000_000,
      geohash: 'qqgu4',
    };
    const fraud = new FakeFraud();
    // While Fraud thinks, time passes to just under the timeout and the sweeper runs: the row is still within its window.
    fraud.onAssess = async () => {
      clock.advance(TIMEOUT_SECONDS - 1);
      await sweeper.sweep();
    };
    const processor = new TransactionProcessor({
      repository: proposedTransactionRepository(db.app),
      clock,
      delay: new FakeDelay(),
      fraudAmountThreshold: 1_000_000,
      waitMs: 3000,
      subjects: new FakeSubjects(),
      fraud,
      notifications: new FakeNotifications(),
      privacy,
      logger: log.logger,
    });
    expect((await processor.process(request)).status).toBe('COMPLETED');
    expect(await statusOf('TX-6001')).toBe('COMPLETED');
  });
});
