import { join } from 'node:path';
import { FakeClock, FakeDelay, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import {
  PendingSweeper,
  TransactionProcessor,
  TransactionRepository,
  TransactionReview,
  type TransactionRequest,
} from '../src/transaction';
import { FakeFraud, FakeNotifications, FakePrivacy, FakeSubjects, recordingLogger } from './fakes';

// Seam: a final status that Privacy has not heard yet (spec transaction 5 step 3, 7; gate 2 decision 1) is repaired by
// the cleaner, on the real transaction database as the real runtime role. The customer is told once and only once.
// Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const THRESHOLD = 1_000_000;
const TIMEOUT_SECONDS = 300;
const ANALYST = 'usr-fraud_analyst';
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');

let db: TestDb;
let clock: FakeClock;
let subjects: FakeSubjects;
let fraud: FakeFraud;
let notifications: FakeNotifications;
let privacy: FakePrivacy;
let log: ReturnType<typeof recordingLogger>;
let processor: TransactionProcessor;
let review: TransactionReview;
let sweeper: PendingSweeper;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm4resync' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T10:00:00.000Z');
  subjects = new FakeSubjects();
  fraud = new FakeFraud();
  notifications = new FakeNotifications();
  privacy = new FakePrivacy();
  log = recordingLogger();
  const repository = new TransactionRepository(db.app);
  processor = new TransactionProcessor({
    repository,
    clock,
    delay: new FakeDelay(),
    fraudAmountThreshold: THRESHOLD,
    waitMs: 3000,
    subjects,
    fraud,
    notifications,
    privacy,
    logger: log.logger,
  });
  review = new TransactionReview({
    repository,
    clock,
    subjects,
    notifications,
    privacy,
    logger: log.logger,
  });
  sweeper = new PendingSweeper({
    repository,
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
const request = (over: Partial<TransactionRequest> = {}): TransactionRequest => {
  sequence += 1;
  return {
    transactionId: `TX-${String(7_000 + sequence)}`,
    idempotencyKey: [KEY.slice(0, 24), String(sequence).padStart(12, '0')].join(''),
    customerToken: 'PSEU-00000001',
    accountToken: 'PSEU-00000002',
    merchantId: 'MRC-001',
    amount: 35000,
    geohash: 'qqgu4',
    ...over,
  };
};
const rowOf = async (id: string) =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [id],
    )
  ).rows[0];
const patchesOf = (id: string) => privacy.patches.filter((p) => p.transactionId === id);

describe('M4-02 FR-10 a PATCH that fails after the customer was told', () => {
  it('M4-02 FR-10 the true status is kept and the row says Privacy has not heard it, with the failure logged by id', async () => {
    privacy.fail = true;
    const r = request();
    expect(await processor.process(r)).toMatchObject({ status: 'COMPLETED', httpStatus: 201 });
    expect(notifications.sent).toHaveLength(1);
    expect(await rowOf(r.transactionId)).toMatchObject({
      status: 'COMPLETED',
      privacy_synced_at: null,
    });
    expect(log.entries.filter((e) => e.event === 'status_patch_failed')).toEqual([
      expect.objectContaining({
        fields: { transaction_id: r.transactionId, reason: 'SERVICE_UNAVAILABLE' },
      }),
    ]);
  });

  it('M4-02 FR-10 a PATCH that works marks the row as heard, so the cleaner has nothing to do', async () => {
    const r = request();
    await processor.process(r);
    expect((await rowOf(r.transactionId))?.privacy_synced_at).toEqual(clock.now());
    clock.advance(TIMEOUT_SECONDS * 10);
    expect(await sweeper.resync()).toBe(0);
    expect(patchesOf(r.transactionId)).toHaveLength(1);
  });

  it('M4-02 FR-10 the cleaner repairs it once, after the window of a request in flight, and never sends the message again', async () => {
    privacy.fail = true;
    const r = request();
    await processor.process(r);
    privacy.fail = false;
    privacy.patches.length = 0;

    // Inside the window the winner may still be working on it (a re-issue needs Privacy to see the transaction open).
    clock.advance(TIMEOUT_SECONDS);
    expect(await sweeper.resync()).toBe(0);
    expect(privacy.patches).toEqual([]);

    clock.advance(1);
    expect(await sweeper.resync()).toBe(1);
    expect(privacy.patches).toEqual([{ transactionId: r.transactionId, status: 'COMPLETED' }]);
    expect((await rowOf(r.transactionId))?.privacy_synced_at).toEqual(clock.now());
    expect(await sweeper.resync()).toBe(0);
    expect(privacy.patches).toHaveLength(1);
    expect(notifications.sent).toHaveLength(1);
  });

  it('M4-02 FR-10 while Privacy stays away the row stays unheard and is tried again on the next run', async () => {
    privacy.fail = true;
    const r = request();
    await processor.process(r);
    clock.advance(TIMEOUT_SECONDS + 1);
    expect(await sweeper.resync()).toBe(0);
    expect((await rowOf(r.transactionId))?.privacy_synced_at).toBeNull();
    expect(log.entries.filter((e) => e.event === 'status_patch_failed')).toHaveLength(2);
    privacy.fail = false;
    expect(await sweeper.resync()).toBe(1);
    expect((await rowOf(r.transactionId))?.privacy_synced_at).not.toBeNull();
  });

  it('M4-02 FR-10 a FAILED and a HELD transaction are repaired too, each with the status Privacy knows for it', async () => {
    privacy.fail = true;
    fraud.decision = 'BLOCK';
    const blocked = request({ amount: THRESHOLD });
    await processor.process(blocked);
    fraud.decision = 'HOLD_FOR_VERIFICATION';
    const held = request({ amount: THRESHOLD });
    await processor.process(held);
    privacy.fail = false;
    privacy.patches.length = 0;
    clock.advance(TIMEOUT_SECONDS + 1);
    expect(await sweeper.resync()).toBe(2);
    expect(patchesOf(blocked.transactionId)).toEqual([
      { transactionId: blocked.transactionId, status: 'FAILED' },
    ]);
    expect(patchesOf(held.transactionId)).toEqual([
      { transactionId: held.transactionId, status: 'IN_PROGRESS' },
    ]);
  });

  it('M4-02 FR-39 a row failed by the sweeper whose PATCH did not go through is repaired by the next run', async () => {
    await db.owner.query(
      `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
          merchant_id, amount, geohash, status, created_at)
        VALUES ('TX-7900', $1, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', 35000, 'qqgu4', 'PENDING', $2)`,
      [KEY, new Date(clock.now().getTime() - (TIMEOUT_SECONDS + 1) * 1000)],
    );
    privacy.fail = true;
    expect(await sweeper.sweep()).toBe(1);
    expect((await rowOf('TX-7900'))?.privacy_synced_at).toBeNull();
    privacy.fail = false;
    expect(await sweeper.resync()).toBe(1);
    expect(patchesOf('TX-7900').at(-1)).toEqual({ transactionId: 'TX-7900', status: 'FAILED' });
  });
});

describe('M4-03 FR-35 a review whose PATCH fails', () => {
  async function held(): Promise<string> {
    fraud.decision = 'HOLD_FOR_VERIFICATION';
    const r = request({ amount: THRESHOLD });
    await processor.process(r);
    return r.transactionId;
  }

  it('M4-03 FR-35 the new status is not taken for heard, although the HELD one was, and the cleaner repairs it with one message in all', async () => {
    const id = await held();
    expect((await rowOf(id))?.privacy_synced_at).not.toBeNull();
    notifications.sent.length = 0;
    clock.advance(60);
    privacy.fail = true;
    await review.review({ transactionId: id, decision: 'APPROVE', reviewedBy: ANALYST });
    expect(await rowOf(id)).toMatchObject({
      status: 'COMPLETED',
      reviewed_by: ANALYST,
      privacy_synced_at: null,
    });
    expect(notifications.sent).toHaveLength(1);

    privacy.fail = false;
    privacy.patches.length = 0;
    clock.advance(TIMEOUT_SECONDS);
    expect(await sweeper.resync()).toBe(0);
    clock.advance(1);
    expect(await sweeper.resync()).toBe(1);
    expect(privacy.patches).toEqual([{ transactionId: id, status: 'COMPLETED' }]);
    expect(notifications.sent).toHaveLength(1);
  });

  it('M4-03 FR-35 a PATCH for the HELD status that arrives after the review is not recorded as hearing the new one', async () => {
    const id = await held();
    // The row has moved on (reviewed) while an earlier PATCH for HELD was still being marked.
    privacy.fail = true;
    await review.review({ transactionId: id, decision: 'REJECT', reviewedBy: ANALYST });
    const repository = new TransactionRepository(db.app);
    await repository.markPrivacySynced(id, 'HELD', clock.now());
    expect((await rowOf(id))?.privacy_synced_at).toBeNull();
  });
});
