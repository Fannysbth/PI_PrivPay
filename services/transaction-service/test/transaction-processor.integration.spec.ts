import { join } from 'node:path';
import {
  DomainError,
  FakeClock,
  FakeDelay,
  loadConfig,
  migrate,
  pgConfigSchema,
  type Delay,
} from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import {
  TransactionProcessor,
  TransactionRepository,
  type TransactionRequest,
} from '../src/transaction';
import {
  FakeFraud,
  FakeNotifications,
  FakePrivacy,
  FakeSubjects,
  neighbours,
  recordingLogger,
} from './fakes';

// Seam: TransactionProcessor.process (spec transaction 3.1, 5.1) on the real transaction database, as the real runtime
// role, with a FakeClock and a FakeDelay. The pseudonyms are invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const WAIT_MS = 3000;
const THRESHOLD = 1_000_000;
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');

let db: TestDb;
let clock: FakeClock;
let delay: FakeDelay;
let processor: TransactionProcessor;

const build = (using: Delay): TransactionProcessor =>
  new TransactionProcessor({
    repository: new TransactionRepository(db.app),
    clock,
    delay: using,
    fraudAmountThreshold: THRESHOLD,
    waitMs: WAIT_MS,
    subjects: new FakeSubjects(),
    // These M4-01 cases are about Fraud being away (NFR-24); the decisions of a Fraud that answers are in M4-02.
    fraud: Object.assign(new FakeFraud(), { fail: true }),
    notifications: new FakeNotifications(),
    privacy: new FakePrivacy(),
    logger: recordingLogger().logger,
  });

beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm401' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  delay = new FakeDelay();
  processor = build(delay);
});
afterEach(async () => {
  await db.close();
});

let sequence = 0;
const request = (over: Partial<TransactionRequest> = {}): TransactionRequest => {
  sequence += 1;
  return {
    transactionId: `TX-${String(1_000 + sequence)}`,
    idempotencyKey: KEY,
    customerToken: 'PSEU-00000001',
    accountToken: 'PSEU-00000002',
    merchantId: 'MRC-001',
    amount: 35000,
    geohash: 'qqgu4',
    ...over,
  };
};
const rows = async (sql = 'SELECT * FROM transactions ORDER BY created_at, transaction_id') =>
  (await db.owner.query<Record<string, unknown>>(sql)).rows;
async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}

describe('M4-01 FR-36 NFR-23 TF-08 idempotency in sequence', () => {
  it('M4-01 FR-36 the first request is 201 and stores tokens and attributes, nothing else', async () => {
    const first = request();
    const result = await processor.process(first);
    expect(result).toEqual({
      status: 'COMPLETED',
      httpStatus: 201,
      body: { transaction_id: first.transactionId, status: 'COMPLETED' },
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      transaction_id: first.transactionId,
      idempotency_key: KEY,
      customer_pseudonym: 'PSEU-00000001',
      account_pseudonym: 'PSEU-00000002',
      merchant_id: 'MRC-001',
      amount: '35000.00',
      geohash: 'qqgu4',
      status: 'COMPLETED',
    });
    expect(row?.['completed_at']).toEqual(clock.now());
  });

  it('M4-01 TF-08 the same request again is 200 with the stored answer and no second row, even under a new transaction_id', async () => {
    const first = await processor.process(request());
    const again = await processor.process(request());
    expect(again).toEqual({ ...first, httpStatus: 200 });
    expect(await rows()).toHaveLength(1);
  });

  it.each([
    ['amount', { amount: 36000 }],
    ['merchant_id', { merchantId: 'MRC-002' }],
    ['geohash', { geohash: 'qqt8h' }],
    ['the source account', { accountToken: 'PSEU-000000AA' }],
    ['the customer', { customerToken: 'PSEU-000000BB' }],
  ])(
    'M4-01 FR-36 TF-08 the same key with another %s is IDEMPOTENCY_CONFLICT and the stored row is untouched',
    async (_name, over) => {
      await processor.process(request());
      const before = await rows();
      expect(await reasonOf(processor.process(request(over)))).toBe('IDEMPOTENCY_CONFLICT');
      expect(await rows()).toEqual(before);
    },
  );

  it('M4-01 TF-08 a replay after the tokens were issued again (outside the window) is IDEMPOTENCY_CONFLICT and makes no second transaction', async () => {
    await processor.process(request());
    clock.advance(901);
    const replay = request({ customerToken: 'PSEU-0000CCCC', accountToken: 'PSEU-0000DDDD' });
    expect(await reasonOf(processor.process(replay))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await rows()).toHaveLength(1);
  });

  it('M4-01 TF-08 a replay inside the window with the same tokens is still 200 (re-issue returns the active token)', async () => {
    const first = await processor.process(request());
    clock.advance(899);
    expect((await processor.process(request())).httpStatus).toBe(200);
    expect((await processor.process(request())).body).toEqual(first.body);
  });

  it('M4-01 TF-08 a replay of a request that was held or failed is 200 with that status', async () => {
    const held = await processor.process(request({ idempotencyKey: 'k-held', amount: THRESHOLD }));
    expect(held.status).toBe('HELD');
    const again = await processor.process(request({ idempotencyKey: 'k-held', amount: THRESHOLD }));
    expect(again).toEqual({ ...held, httpStatus: 200 });
  });
});

describe('M4-01 K-16 a request the platform refuses is refused before any row exists', () => {
  it('M4-01 K-16 an unknown merchant_id is VALIDATION_ERROR and leaves no row', async () => {
    expect(await reasonOf(processor.process(request({ merchantId: 'MRC-999' })))).toBe(
      'VALIDATION_ERROR',
    );
    expect(await rows()).toHaveLength(0);
  });

  it.each([[0], [-5], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]])(
    'M4-01 K-16 the amount %s is VALIDATION_ERROR and leaves no row',
    async (amount) => {
      expect(await reasonOf(processor.process(request({ amount })))).toBe('VALIDATION_ERROR');
      expect(await rows()).toHaveLength(0);
    },
  );

  it('M4-01 K-16 an amount of 1 is accepted', async () => {
    expect((await processor.process(request({ amount: 1 }))).httpStatus).toBe(201);
  });
});

describe('M4-01 NFR-24 until Fraud is wired, an amount at or over the threshold is never completed', () => {
  it('M4-01 NFR-24 the threshold decides: under it COMPLETED, at it HELD with FRAUD_UNAVAILABLE and no completed_at', async () => {
    const under = await processor.process(
      request({ idempotencyKey: 'k-under', amount: THRESHOLD - 1 }),
    );
    const at = await processor.process(request({ idempotencyKey: 'k-at', amount: THRESHOLD }));
    expect([under.status, at.status]).toEqual(['COMPLETED', 'HELD']);
    const held = await rows(`SELECT * FROM transactions WHERE idempotency_key = 'k-at'`);
    expect(held[0]).toMatchObject({ fraud_decision: 'FRAUD_UNAVAILABLE', completed_at: null });
  });
});

describe('M4-01 NFR-23 S-02 T-13 the same key at the same time', () => {
  // 20 rounds, as the Phase 2 criterion asks. Each round uses its own key, so a round cannot hide behind the last.
  it.each([[2], [20]])(
    'M4-01 NFR-23 T-13 %s identical requests at once, 20 rounds: one row, every answer 200 or 201 with the same transaction_id, no 5xx',
    async (parallel) => {
      for (let round = 0; round < 20; round += 1) {
        const key = `00000000-0000-4000-8000-${String(round).padStart(12, '0')}`;
        // Nobody sleeps: the wait is long only in the fake delay's terms, it bounds how often a loser looks again.
        const results = await Promise.allSettled(
          Array.from({ length: parallel }, () =>
            new TransactionProcessor({
              repository: new TransactionRepository(db.app),
              clock,
              delay: new FakeDelay(),
              fraudAmountThreshold: THRESHOLD,
              waitMs: 600_000,
              ...neighbours({ fraudDown: true }),
              logger: recordingLogger().logger,
            }).process(request({ idempotencyKey: key })),
          ),
        );
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
        const values = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        expect(values.filter((value) => value.httpStatus === 201)).toHaveLength(1);
        expect(new Set(values.map((value) => value.body.transaction_id)).size).toBe(1);
        const stored = await rows(
          `SELECT transaction_id FROM transactions WHERE idempotency_key = '${key}'`,
        );
        expect(stored).toHaveLength(1);
        expect(stored[0]?.['transaction_id']).toBe(values[0]?.body.transaction_id);
      }
    },
    120_000,
  );

  it('M4-01 NFR-23 T-13 the same key with different content at once: one wins with 201, the others are IDEMPOTENCY_CONFLICT', async () => {
    for (let round = 0; round < 20; round += 1) {
      const key = `10000000-0000-4000-8000-${String(round).padStart(12, '0')}`;
      const results = await Promise.allSettled(
        [35000, 36000, 37000].map((amount) =>
          new TransactionProcessor({
            repository: new TransactionRepository(db.app),
            clock,
            delay: new FakeDelay(),
            fraudAmountThreshold: THRESHOLD,
            waitMs: 600_000,
            ...neighbours({ fraudDown: true }),
            logger: recordingLogger().logger,
          }).process(request({ idempotencyKey: key, amount })),
        ),
      );
      const won = results.filter((result) => result.status === 'fulfilled');
      const lost = results.filter((result) => result.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      for (const result of lost) {
        expect((result.reason as DomainError).reason).toBe('IDEMPOTENCY_CONFLICT');
      }
    }
  }, 120_000);
});

describe('M4-01 K-25 the winner that has not finished', () => {
  const stalled = async (): Promise<void> => {
    await db.owner.query(
      `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
          merchant_id, amount, geohash, status, created_at)
       VALUES ('TX-STALLED', $1, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', 35000, 'qqgu4', 'PENDING', now())`,
      [KEY],
    );
  };

  it('M4-01 K-25 the loser waits through the Delay for HTTP_TIMEOUT_MS in all, never longer, then IDEMPOTENCY_CONFLICT', async () => {
    await stalled();
    expect(await reasonOf(processor.process(request()))).toBe('IDEMPOTENCY_CONFLICT');
    expect(delay.waits.length).toBeGreaterThan(0);
    expect(delay.waits.reduce((sum, ms) => sum + ms, 0)).toBe(WAIT_MS);
    expect(await rows()).toHaveLength(1);
  });

  it('M4-01 K-25 a winner that finishes while the loser waits makes the loser 200 with the stored answer', async () => {
    await stalled();
    let waits = 0;
    const finishing: Delay = {
      wait: async () => {
        waits += 1;
        if (waits === 2) {
          await db.owner.query(
            `UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE transaction_id = 'TX-STALLED'`,
          );
        }
      },
    };
    const result = await build(finishing).process(request());
    expect(result).toEqual({
      status: 'COMPLETED',
      httpStatus: 200,
      body: { transaction_id: 'TX-STALLED', status: 'COMPLETED' },
    });
    expect(waits).toBe(2);
  });

  it('M4-01 K-25 a stalled winner with different content is IDEMPOTENCY_CONFLICT at once, without waiting', async () => {
    await stalled();
    expect(await reasonOf(processor.process(request({ amount: 40000 })))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(delay.waits).toEqual([]);
  });
});

describe('M4-01 the same transaction_id under another key', () => {
  it('M4-01 a transaction_id that already exists under another key is IDEMPOTENCY_CONFLICT, not a 500', async () => {
    const first = request({ idempotencyKey: 'k-one' });
    await processor.process(first);
    const clash = request({ idempotencyKey: 'k-two', transactionId: first.transactionId });
    expect(await reasonOf(processor.process(clash))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await rows()).toHaveLength(1);
  });
});
