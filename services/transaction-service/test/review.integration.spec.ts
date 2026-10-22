import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { TransactionRepository, TransactionReview } from '../src/transaction';
import { FakeNotifications, FakePrivacy, FakeSubjects, recordingLogger } from './fakes';

// Seam: TransactionReview (spec transaction 3.2, 3.3) on the real transaction database as the real runtime role, with
// a FakeClock. Neighbours are doubles. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const ANALYST = 'usr-fraud_analyst';

let db: TestDb;
let clock: FakeClock;
let subjects: FakeSubjects;
let notifications: FakeNotifications;
let privacy: FakePrivacy;
let log: ReturnType<typeof recordingLogger>;
let review: TransactionReview;

const buildReview = (): TransactionReview =>
  new TransactionReview({
    repository: new TransactionRepository(db.app),
    clock,
    subjects,
    notifications,
    privacy,
    logger: log.logger,
  });

beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm403' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T10:00:00.000Z');
  subjects = new FakeSubjects();
  notifications = new FakeNotifications();
  privacy = new FakePrivacy();
  log = recordingLogger();
  review = buildReview();
});
afterEach(async () => {
  await db.close();
});

let sequence = 0;
async function seed(
  status: string,
  over: { amount?: number; createdAt?: string; id?: string } = {},
): Promise<string> {
  sequence += 1;
  const id = over.id ?? `TX-${String(4_000 + sequence)}`;
  await db.owner.query(
    `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
        merchant_id, amount, geohash, status, fraud_decision, risk_score, created_at)
      VALUES ($1, $2, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', $3, 'qqgu4', $4::varchar,
        CASE WHEN $4::varchar = 'HELD' THEN 'HOLD_FOR_VERIFICATION' END,
        CASE WHEN $4::varchar = 'HELD' THEN 55.5 END, $5)`,
    [
      id,
      ['00000000', '0000', '4000', '8000', String(sequence).padStart(12, '0')].join('-'),
      over.amount ?? 2_000_000,
      status,
      over.createdAt ?? clock.now().toISOString(),
    ],
  );
  return id;
}
const rowOf = async (id: string) =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [id],
    )
  ).rows[0];
async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}

describe('M4-03 FR-34 TF-09 the list of HELD transactions', () => {
  it('M4-03 FR-34 lists only HELD, oldest first, with amount, score, decision and time, and no identity or token', async () => {
    await seed('COMPLETED');
    await seed('FAILED');
    await seed('PENDING');
    const second = await seed('HELD', { createdAt: '2026-10-20T09:02:00.000Z' });
    const first = await seed('HELD', { createdAt: '2026-10-20T09:01:00.000Z' });
    const page = await review.listHeld({ limit: 50 });
    expect(page.items.map((item) => item.transaction_id)).toEqual([first, second]);
    expect(page.items[0]).toEqual({
      transaction_id: first,
      amount: 2_000_000,
      risk_score: 55.5,
      fraud_decision: 'HOLD_FOR_VERIFICATION',
      created_at: '2026-10-20T09:01:00.000Z',
    });
    expect(page.next_cursor).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/PSEU-|customer|account|geohash/i);
  });

  it('M4-03 FR-34 pages by an opaque cursor without skipping or repeating a row, even with equal times', async () => {
    const same = '2026-10-20T09:00:00.000Z';
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seed('HELD', { createdAt: same }));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await review.listHeld({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.items.map((item) => item.transaction_id));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].sort());
  });

  it.each(['', 'abc', 'e30', '!!!!'])(
    'M4-03 FR-34 the cursor %j that this service did not make is VALIDATION_ERROR',
    async (cursor) => {
      expect(await reasonOf(review.listHeld({ limit: 10, cursor }))).toBe('VALIDATION_ERROR');
    },
  );
});

describe('M4-03 FR-35 TF-10 review', () => {
  it('M4-03 FR-35 APPROVE completes the transaction, records who and when, tells Privacy and the customer', async () => {
    const id = await seed('HELD');
    clock.advance(600);
    const result = await review.review({
      transactionId: id,
      decision: 'APPROVE',
      reviewedBy: ANALYST,
    });
    expect(result).toEqual({
      transaction_id: id,
      status: 'COMPLETED',
      reviewed_at: '2026-10-20T10:10:00.000Z',
    });
    expect(await rowOf(id)).toMatchObject({
      status: 'COMPLETED',
      reviewed_by: ANALYST,
      reviewed_at: clock.now(),
      completed_at: clock.now(),
    });
    expect(privacy.patches).toEqual([{ transactionId: id, status: 'COMPLETED' }]);
    expect(notifications.sent.map((n) => [n.template, n.transactionId])).toEqual([
      ['TX_COMPLETED', id],
    ]);
  });

  it('M4-03 FR-35 REJECT fails the transaction without a completion time and sends TX_REJECTED', async () => {
    const id = await seed('HELD');
    const result = await review.review({
      transactionId: id,
      decision: 'REJECT',
      reviewedBy: ANALYST,
    });
    expect(result.status).toBe('FAILED');
    expect(await rowOf(id)).toMatchObject({
      status: 'FAILED',
      reviewed_by: ANALYST,
      completed_at: null,
    });
    expect(privacy.patches).toEqual([{ transactionId: id, status: 'FAILED' }]);
    expect(notifications.sent.map((n) => n.template)).toEqual(['TX_REJECTED']);
  });

  it('M4-03 TF-04 a token that expired while the transaction was held is issued again before Privacy is told the end', async () => {
    const id = await seed('HELD');
    subjects.expireNotification = 1;
    await review.review({ transactionId: id, decision: 'APPROVE', reviewedBy: ANALYST });
    expect(subjects.reissued).toHaveLength(1);
    expect(notifications.sent).toHaveLength(1);
    // Privacy refuses a re-issue once the transaction is final there, so the message goes first (spec transaction 5 step 5).
    expect(privacy.patches).toHaveLength(1);
  });

  it.each(['COMPLETED', 'FAILED', 'PENDING'])(
    'M4-03 TF-10 a %s transaction is NOT_HELD and nothing changes or is sent',
    async (status) => {
      const id = await seed(status);
      const before = await rowOf(id);
      expect(
        await reasonOf(
          review.review({ transactionId: id, decision: 'APPROVE', reviewedBy: ANALYST }),
        ),
      ).toBe('NOT_HELD');
      expect(await rowOf(id)).toEqual(before);
      expect(privacy.patches).toHaveLength(0);
      expect(notifications.sent).toHaveLength(0);
    },
  );

  it('M4-03 TF-10 an unknown transaction is NOT_HELD too: there is nothing held under that id', async () => {
    expect(
      await reasonOf(
        review.review({ transactionId: 'TX-999999', decision: 'REJECT', reviewedBy: ANALYST }),
      ),
    ).toBe('NOT_HELD');
  });

  it('M4-03 TF-10 the second decision on the same transaction is NOT_HELD and the first stays', async () => {
    const id = await seed('HELD');
    await review.review({ transactionId: id, decision: 'APPROVE', reviewedBy: ANALYST });
    expect(
      await reasonOf(
        review.review({ transactionId: id, decision: 'REJECT', reviewedBy: 'usr-other' }),
      ),
    ).toBe('NOT_HELD');
    expect(await rowOf(id)).toMatchObject({ status: 'COMPLETED', reviewed_by: ANALYST });
    expect(notifications.sent).toHaveLength(1);
  });

  it('M4-03 FR-35 a Notification or Privacy that fails does not undo the decision, and the miss is logged with the id only', async () => {
    const id = await seed('HELD');
    notifications.fail = true;
    privacy.fail = true;
    const result = await review.review({
      transactionId: id,
      decision: 'APPROVE',
      reviewedBy: ANALYST,
    });
    expect(result.status).toBe('COMPLETED');
    expect((await rowOf(id))?.status).toBe('COMPLETED');
    const events = log.entries.map((entry) => entry.event).sort();
    expect(events).toEqual(['notification_failed', 'status_patch_failed']);
    for (const entry of log.entries) expect(entry.fields).toMatchObject({ transaction_id: id });
  });

  it.each([2, 3, 8])(
    'M4-03 TF-10 %i reviews at the same moment: exactly one wins and the others are NOT_HELD',
    async (parallel) => {
      const id = await seed('HELD');
      // Another session holds the row, so every review is parked on the lock before any of them can read the status:
      // the overlap is forced, not hoped for.
      const holder = await db.owner.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM transactions WHERE transaction_id = $1 FOR UPDATE', [id]);
      const reviews = Array.from({ length: parallel }, (_unused, i) =>
        reasonOf(
          buildReview().review({
            transactionId: id,
            decision: i % 2 === 0 ? 'APPROVE' : 'REJECT',
            reviewedBy: `usr-analyst-${String(i)}`,
          }),
        ),
      );
      await waitUntilBlocked(db, parallel);
      await holder.query('COMMIT');
      holder.release();
      const outcomes = await Promise.all(reviews);
      expect(outcomes.filter((outcome) => outcome === 'no error')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'NOT_HELD')).toHaveLength(parallel - 1);
      const row = await rowOf(id);
      expect(['COMPLETED', 'FAILED']).toContain(row?.status);
      expect(String(row?.reviewed_by)).toMatch(/^usr-analyst-/);
    },
  );
});

/** Waits (by looking at the database, not by sleeping) until `count` sessions are queued on a row lock. */
async function waitUntilBlocked(test: TestDb, count: number): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    // pg_locks is readable by every role; pg_stat_activity hides other roles' waits from a non-superuser.
    const blocked = await test.owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_locks WHERE NOT granted',
    );
    if (Number(blocked.rows[0]?.n) >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the reviews did not queue on the row lock');
}
