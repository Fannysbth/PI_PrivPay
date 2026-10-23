import { join } from 'node:path';
import { FakeClock, FakeDelay, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { compareSchemas } from '../../../tests/baseline/schema-parity';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { baselineSubjectReferences, baselineTransactionRepository } from '../src/baseline';
import { proposedTransactionRepository } from '../src/proposed';
import { TransactionProcessor } from '../src/transaction';
import { FakeFraud, FakeNotifications, FakePrivacy, recordingLogger } from './fakes';

// Seam: the baseline transaction-db and its repository, on PostgreSQL as the real runtime role (ADR-0006, M5-01). The
// baseline holds real identities on purpose, so every identity here is a canary or an invented value.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const person = buildCanary(51);
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');

let db: TestDb;
let other: TestDb | undefined;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm501b' });
  await migrate(db.owner, { root: migrations, mode: 'baseline' });
});
afterEach(async () => {
  await db.close();
  await other?.close();
  other = undefined;
});

const newRow = (over: Record<string, unknown> = {}) => ({
  transactionId: 'TX-5001',
  idempotencyKey: KEY,
  customerToken: person.customer_id,
  accountToken: person.rekening,
  merchantId: 'MRC-001',
  amount: 35000,
  geohash: 'qqgu4',
  createdAt: new Date('2026-10-23T01:00:00.000Z'),
  ...over,
});

describe('M5-01 FR-23 the baseline schema keeps the identity where proposed keeps the token', () => {
  it('M5-01 FR-23 transactions has customer_id and account_number, and no pseudonym column', async () => {
    const found = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'transactions'`,
    );
    const names = found.rows.map((row) => row.column_name);
    expect(names).toEqual(expect.arrayContaining(['customer_id', 'account_number']));
    expect(names.filter((name) => name.includes('pseudonym'))).toEqual([]);
  });

  it('M5-01 FR-23 apart from the two identity columns the schema and the grants are those of proposed', async () => {
    other = await createTestDb(config, { service: 'transaction', suffix: 'm501p' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    const report = await compareSchemas(
      other.owner,
      db.owner,
      {
        'transactions.customer_pseudonym': 'transactions.customer_id',
        'transactions.account_pseudonym': 'transactions.account_number',
      },
      { proposed: 'privpay_transaction_app', baseline: 'privpay_transaction_app' },
    );
    expect(report).toEqual({ missing: [], different: [], grants: [] });
  });

  it('M5-01 NFR-09 the runtime role can read and write but not delete, as in proposed', async () => {
    await expect(db.app.query('DELETE FROM transactions')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('M5-01 FR-23 the baseline repository is the same domain over the other columns', () => {
  it('M5-01 FR-23 stores the identity and reads it back as it was given, and the idempotency key still decides', async () => {
    const repository = baselineTransactionRepository('baseline', db.app);
    expect(await repository.insertPending(newRow())).toBe(true);
    expect(await repository.insertPending(newRow({ transactionId: 'TX-5002' }))).toBe(false);
    expect(await repository.findByKey(KEY)).toMatchObject({
      transactionId: 'TX-5001',
      customerToken: person.customer_id,
      accountToken: person.rekening,
      status: 'PENDING',
    });
    const stored = await db.owner.query(
      'SELECT customer_id, account_number FROM transactions WHERE transaction_id = $1',
      ['TX-5001'],
    );
    expect(stored.rows).toEqual([
      { customer_id: person.customer_id, account_number: person.rekening },
    ]);
  });

  it('M5-01 FR-23 a held transaction is decided once and answers with the identity for the follow-up', async () => {
    const repository = baselineTransactionRepository('baseline', db.app);
    await repository.insertPending(newRow());
    const at = new Date('2026-10-23T01:05:00.000Z');
    await repository.finish('TX-5001', {
      status: 'HELD',
      riskScore: 40,
      fraudDecision: 'HOLD_FOR_VERIFICATION',
      completedAt: null,
    });
    const decided = await repository.decideHeld('TX-5001', {
      status: 'COMPLETED',
      fraudDecision: 'HOLD_FOR_VERIFICATION',
      completedAt: at,
      reviewedBy: 'usr-fraud_analyst',
      reviewedAt: at,
    });
    expect(decided).toMatchObject({
      customerToken: person.customer_id,
      accountToken: person.rekening,
    });
    const again = await repository.decideHeld('TX-5001', {
      status: 'FAILED',
      fraudDecision: null,
      completedAt: null,
    });
    expect(again).toBeUndefined();
  });

  it('M5-01 FR-23 updateTokens and findById read the same columns', async () => {
    const repository = baselineTransactionRepository('baseline', db.app);
    await repository.insertPending(newRow());
    await repository.updateTokens('TX-5001', {
      customerToken: 'CUST-000102',
      accountToken: '1234567802',
    });
    expect(await repository.findById('TX-5001')).toMatchObject({
      customerToken: 'CUST-000102',
      accountToken: '1234567802',
    });
  });

  it('M5-01 FR-23 the reads of an audit give no identity, as in proposed', async () => {
    const repository = baselineTransactionRepository('baseline', db.app);
    await repository.insertPending(newRow());
    const detail = JSON.stringify(await repository.findDetail('TX-5001'));
    expect(detail).not.toContain(person.customer_id);
    expect(detail).not.toContain(person.rekening);
  });

  it('M5-01 ADR-0006 refuses to be built in the proposed mode', () => {
    expect(() => baselineTransactionRepository('proposed', db.app)).toThrow(
      /PRIVACY_MODE=baseline/,
    );
  });
});

describe('M5-01 FR-23 US-09 the same processor runs on the baseline adapters', () => {
  it('M5-01 FR-23 a payment completes, Fraud and Notification get the customer_id, and Privacy is never asked', async () => {
    const fraud = new FakeFraud();
    const notifications = new FakeNotifications();
    const privacy = new FakePrivacy();
    const processor = new TransactionProcessor({
      repository: baselineTransactionRepository('baseline', db.app),
      clock: new FakeClock('2026-10-23T01:00:00.000Z'),
      delay: new FakeDelay(),
      fraudAmountThreshold: 1_000_000,
      waitMs: 3000,
      subjects: baselineSubjectReferences('baseline'),
      fraud,
      notifications,
      privacy,
      logger: recordingLogger().logger,
    });
    const result = await processor.process({
      transactionId: 'TX-5010',
      idempotencyKey: KEY,
      customerToken: person.customer_id,
      accountToken: person.rekening,
      merchantId: 'MRC-001',
      amount: 2_000_000,
      geohash: 'qqgu4',
    });
    expect(result).toMatchObject({ status: 'COMPLETED', httpStatus: 201 });
    expect(fraud.calls.map((call) => call.subject)).toEqual([person.customer_id]);
    expect(notifications.sent.map((sent) => sent.subject)).toEqual([person.customer_id]);
  });
});

describe('M5-01 NFR-15 the positive control: in baseline the scanner finds the real data', () => {
  it('M5-01 NFR-15 FR-23 the canary customer_id and account number are found in the dump, and not in proposed', async () => {
    await baselineTransactionRepository('baseline', db.app).insertPending(newRow());
    const found = await scanDatabase(db.owner, [person], 'transaction');
    expect(found.map((finding) => finding.location)).toEqual(
      expect.arrayContaining(['transactions.account_number', 'transactions.customer_id']),
    );

    other = await createTestDb(config, { service: 'transaction', suffix: 'm501q' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    await proposedTransactionRepository(other.app).insertPending(
      newRow({ customerToken: 'PSEU-00000001', accountToken: 'PSEU-00000002' }),
    );
    expect(await scanDatabase(other.owner, [person], 'transaction')).toEqual([]);
  });
});
