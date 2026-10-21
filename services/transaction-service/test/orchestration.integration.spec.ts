import { join } from 'node:path';
import { FakeClock, FakeDelay, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import {
  TransactionProcessor,
  TransactionRepository,
  type TransactionRequest,
} from '../src/transaction';
import { FakeFraud, FakeNotifications, FakePrivacy, FakeSubjects, recordingLogger } from './fakes';

// Seam: TransactionProcessor.process with the decisions of Fraud, Notification and Privacy injected (spec transaction
// 5, steps 2..5), on the real transaction database as the real runtime role. Needs PostgreSQL and bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const THRESHOLD = 1_000_000;
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');

let db: TestDb;
let clock: FakeClock;
let subjects: FakeSubjects;
let fraud: FakeFraud;
let notifications: FakeNotifications;
let privacy: FakePrivacy;
let log: ReturnType<typeof recordingLogger>;
let processor: TransactionProcessor;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm402' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T23:30:00.000Z');
  subjects = new FakeSubjects();
  fraud = new FakeFraud();
  notifications = new FakeNotifications();
  privacy = new FakePrivacy();
  log = recordingLogger();
  processor = new TransactionProcessor({
    repository: new TransactionRepository(db.app),
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
});
afterEach(async () => {
  await db.close();
});

let sequence = 0;
const request = (over: Partial<TransactionRequest> = {}): TransactionRequest => {
  sequence += 1;
  return {
    transactionId: `TX-${String(2_000 + sequence)}`,
    idempotencyKey: KEY,
    customerToken: 'PSEU-00000001',
    accountToken: 'PSEU-00000002',
    merchantId: 'MRC-001',
    amount: 35000,
    geohash: 'qqgu4',
    ...over,
  };
};
const row = async () =>
  (await db.owner.query<Record<string, unknown>>('SELECT * FROM transactions')).rows[0];

describe('M4-02 FR-40 TF-02 TF-03 the decision of fraud', () => {
  it('M4-02 TF-02 an amount under the threshold completes without asking Fraud, and tells Privacy and the customer', async () => {
    const r = request({ amount: THRESHOLD - 1 });
    expect((await processor.process(r)).status).toBe('COMPLETED');
    expect(fraud.calls).toHaveLength(0);
    expect(subjects.fraudRows).toHaveLength(0);
    expect(privacy.patches).toEqual([{ transactionId: r.transactionId, status: 'COMPLETED' }]);
    expect(notifications.sent).toEqual([
      {
        subject: 'PSEU-A0000001',
        template: 'TX_COMPLETED',
        amount: THRESHOLD - 1,
        transactionId: r.transactionId,
      },
    ]);
  });

  it('M4-02 TF-03 an amount at the threshold is assessed: ALLOW completes and keeps the score', async () => {
    const r = request({ amount: THRESHOLD });
    const result = await processor.process(r);
    expect(result).toMatchObject({ status: 'COMPLETED', httpStatus: 201 });
    // 23:30 UTC, the hour is the one of the injected clock and not of the machine.
    expect(fraud.calls).toEqual([
      { subject: 'PSEU-F0000001', amount: THRESHOLD, txHour: 23, geohash: 'qqgu4' },
    ]);
    expect(await row()).toMatchObject({
      status: 'COMPLETED',
      fraud_decision: 'ALLOW',
      risk_score: '12.50',
    });
    expect((await row())?.completed_at).toEqual(clock.now());
  });

  it('M4-02 TF-03 HOLD_FOR_VERIFICATION holds, shows IN_PROGRESS to Privacy, and asks the customer to verify', async () => {
    fraud.decision = 'HOLD_FOR_VERIFICATION';
    const r = request({ amount: THRESHOLD });
    expect((await processor.process(r)).status).toBe('HELD');
    expect(await row()).toMatchObject({
      status: 'HELD',
      fraud_decision: 'HOLD_FOR_VERIFICATION',
      completed_at: null,
    });
    expect(privacy.patches).toEqual([{ transactionId: r.transactionId, status: 'IN_PROGRESS' }]);
    expect(notifications.sent.map((n) => n.template)).toEqual(['TX_HELD_VERIFY']);
  });

  it('M4-02 TF-03 BLOCK fails the transaction and tells the customer it was rejected', async () => {
    fraud.decision = 'BLOCK';
    const r = request({ amount: THRESHOLD });
    expect((await processor.process(r)).status).toBe('FAILED');
    expect(await row()).toMatchObject({ status: 'FAILED', fraud_decision: 'BLOCK' });
    expect(privacy.patches).toEqual([{ transactionId: r.transactionId, status: 'FAILED' }]);
    expect(notifications.sent.map((n) => n.template)).toEqual(['TX_REJECTED']);
  });
});

describe('M4-02 NFR-24 TF-11 Fraud away is fail closed', () => {
  it.each([
    [
      'Fraud fails or times out',
      () => {
        fraud.fail = true;
      },
    ],
    [
      'the exchange for Fraud fails',
      () => {
        subjects.failFraudExchange = true;
      },
    ],
  ])(
    'M4-02 TF-11 %s: an amount over the threshold is HELD with FRAUD_UNAVAILABLE and never COMPLETED',
    async (_name, arrange) => {
      arrange();
      const r = request({ amount: THRESHOLD * 5 });
      const result = await processor.process(r);
      expect(result.status).toBe('HELD');
      expect(await row()).toMatchObject({
        status: 'HELD',
        fraud_decision: 'FRAUD_UNAVAILABLE',
        completed_at: null,
      });
      expect(notifications.sent.map((n) => n.template)).toEqual(['TX_HELD_VERIFY']);
      expect(log.entries.find((e) => e.event === 'fraud_unavailable')?.fields).toEqual({
        transaction_id: r.transactionId,
        reason: 'SERVICE_UNAVAILABLE',
      });
    },
  );

  it('M4-02 TF-11 an amount under the threshold does not depend on Fraud at all', async () => {
    fraud.fail = true;
    expect((await processor.process(request({ amount: THRESHOLD - 1 }))).status).toBe('COMPLETED');
  });
});

describe('M4-02 FR-17 TF-04 Notification and Privacy away do not undo the transaction', () => {
  it.each([
    [
      'throws',
      () => {
        notifications.fail = true;
      },
    ],
    [
      'answers FAILED',
      () => {
        notifications.answer = 'FAILED';
      },
    ],
    [
      'cannot exchange the token',
      () => {
        subjects.failNotificationExchange = true;
      },
    ],
  ])(
    'M4-02 FR-17 Notification %s: the transaction stays COMPLETED and the miss is logged with the id only',
    async (_name, arrange) => {
      arrange();
      const r = request();
      expect((await processor.process(r)).status).toBe('COMPLETED');
      expect((await row())?.status).toBe('COMPLETED');
      expect(log.entries.find((e) => e.event === 'notification_failed')?.fields).toMatchObject({
        transaction_id: r.transactionId,
      });
    },
  );

  it('M4-02 FR-10 a failed PATCH to Privacy keeps the local status and is logged with the id only', async () => {
    privacy.fail = true;
    const r = request();
    expect((await processor.process(r)).status).toBe('COMPLETED');
    expect((await row())?.status).toBe('COMPLETED');
    expect(log.entries.find((e) => e.event === 'status_patch_failed')?.fields).toMatchObject({
      transaction_id: r.transactionId,
    });
  });
});

describe('M4-02 FR-39 a winner that answers after the sweeper has failed its row', () => {
  it('M4-02 FR-39 answers the stored FAILED once: no overwrite, no PATCH, no message, no second answer', async () => {
    // The sweeper acts while Fraud is thinking: the row is FAILED before the winner can finish it.
    fraud.onAssess = async () => {
      await db.owner.query("UPDATE transactions SET status = 'FAILED'");
    };
    const r = request({ amount: THRESHOLD });
    const result = await processor.process(r);
    expect(result).toMatchObject({
      status: 'FAILED',
      body: { transaction_id: r.transactionId, status: 'FAILED' },
    });
    expect(await row()).toMatchObject({
      status: 'FAILED',
      fraud_decision: null,
      completed_at: null,
    });
    expect(privacy.patches).toHaveLength(0);
    expect(notifications.sent).toHaveLength(0);
    // A replay of the same request gets the same stored word.
    expect(await processor.process(r)).toMatchObject({ status: 'FAILED', httpStatus: 200 });
  });
});

describe('M4-02 TF-04 a token that expired in the middle of the work', () => {
  it('M4-02 TF-04 issues both tokens again, stores them, and tries the exchange once more', async () => {
    subjects.expireFraud = 1;
    const r = request({ amount: THRESHOLD });
    expect((await processor.process(r)).status).toBe('COMPLETED');
    expect(subjects.reissued).toHaveLength(1);
    expect(subjects.fraudRows.map((x) => x.customerToken)).toEqual([
      'PSEU-00000001',
      'PSEU-0000AAA1',
    ]);
    expect(await row()).toMatchObject({
      customer_pseudonym: 'PSEU-0000AAA1',
      account_pseudonym: 'PSEU-0000AAA2',
    });
    // The notification step then uses the new tokens without needing another re-issue.
    expect(subjects.notificationRows.map((x) => x.customerToken)).toEqual(['PSEU-0000AAA1']);
    expect(subjects.reissued).toHaveLength(1);
  });

  it('M4-02 TF-04 expires twice: only one retry, then the step has failed (Fraud: HELD)', async () => {
    subjects.expireFraud = 2;
    expect((await processor.process(request({ amount: THRESHOLD }))).status).toBe('HELD');
    expect(subjects.fraudRows).toHaveLength(2);
    expect(subjects.reissued).toHaveLength(1);
  });

  it('M4-02 TF-04 a re-issue that is refused (terminal transaction) is a failed step, not a fallback to raw data', async () => {
    subjects.expireFraud = 1;
    subjects.failReissue = true;
    expect(await processor.process(request({ amount: THRESHOLD }))).toMatchObject({
      status: 'HELD',
    });
    expect(subjects.fraudRows).toHaveLength(1);
    expect(fraud.calls).toHaveLength(0);
  });

  it('M4-02 TF-04 an expired token at the notification step is issued again once, and the message goes out', async () => {
    subjects.expireNotification = 1;
    expect((await processor.process(request())).status).toBe('COMPLETED');
    expect(subjects.reissued).toHaveLength(1);
    expect(notifications.sent).toHaveLength(1);
  });
});
