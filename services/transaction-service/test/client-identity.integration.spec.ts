import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { FakeClock, FakeDelay, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { scanText } from '../../../tests/pii-scan/scan';
import { baselineSubjectReferences, baselineTransactionRepository } from '../src/baseline';
import { proposedTransactionRepository } from '../src/proposed';
import { TransactionProcessor } from '../src/transaction';
import { FakeFraud, FakeNotifications, FakePrivacy, FakeSubjects, recordingLogger } from './fakes';

// Seam: G3 / G6 on the Transaction side, on PostgreSQL as the real runtime role. Baseline stores the NIK and the name
// the client sent (Tabel IV: Transaction 4/6) and hands them, with the account number, to Fraud; proposed stores and
// hands over nothing of the kind. The canaries are built at run time from a random index.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const person = buildCanary(randomInt(1000, 99_000));
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');

let db: TestDb;
afterEach(async () => {
  await db.close();
});

const request = (over: Record<string, unknown> = {}) => ({
  transactionId: 'TX-6010',
  idempotencyKey: KEY,
  customerSubjectRef: person.customer_id,
  accountSubjectRef: person.rekening,
  merchantId: 'MRC-001',
  amount: 2_000_000,
  geohash: 'qqgu4',
  ...over,
});

describe('G6 baseline Transaction stores the NIK and the name the client sent', () => {
  beforeEach(async () => {
    db = await createTestDb(config, { service: 'transaction', suffix: 'g3b' });
    await migrate(db.owner, { root: migrations, mode: 'baseline' });
  });

  const baselineProcessor = (fraud: FakeFraud, logger = recordingLogger().logger) =>
    new TransactionProcessor({
      repository: baselineTransactionRepository('baseline', db.app),
      clock: new FakeClock('2026-10-23T01:00:00.000Z'),
      delay: new FakeDelay(),
      fraudAmountThreshold: 1_000_000,
      waitMs: 3000,
      subjects: baselineSubjectReferences('baseline'),
      fraud,
      notifications: new FakeNotifications(),
      privacy: new FakePrivacy(),
      logger,
    });

  it('G6 the runtime role writes nik and nama, and the row reads them back', async () => {
    const repository = baselineTransactionRepository('baseline', db.app);
    expect(
      await repository.insertPending({
        transactionId: 'TX-6001',
        idempotencyKey: KEY,
        customerSubjectRef: person.customer_id,
        accountSubjectRef: person.rekening,
        merchantId: 'MRC-001',
        amount: 35_000,
        geohash: 'qqgu4',
        createdAt: new Date('2026-10-23T01:00:00.000Z'),
        clientIdentity: { nik: person.nik, nama: person.nama },
      }),
    ).toBe(true);
    const stored = await db.owner.query('SELECT nik, nama FROM transactions');
    expect(stored.rows).toEqual([{ nik: person.nik, nama: person.nama }]);
    expect(await repository.findById('TX-6001')).toMatchObject({
      clientIdentity: { nik: person.nik, nama: person.nama },
    });
  });

  it('G6 a payment without them leaves both columns empty and reads back without an identity', async () => {
    const repository = baselineTransactionRepository('baseline', db.app);
    await repository.insertPending({
      transactionId: 'TX-6002',
      idempotencyKey: KEY,
      customerSubjectRef: person.customer_id,
      accountSubjectRef: person.rekening,
      merchantId: 'MRC-001',
      amount: 35_000,
      geohash: 'qqgu4',
      createdAt: new Date('2026-10-23T01:00:00.000Z'),
    });
    expect((await db.owner.query('SELECT nik, nama FROM transactions')).rows).toEqual([
      { nik: null, nama: null },
    ]);
    expect((await repository.findById('TX-6002'))?.clientIdentity).toBeUndefined();
  });

  it('G6 the runtime role still cannot delete, and the e-mail and the phone have no column', async () => {
    await expect(db.app.query('DELETE FROM transactions')).rejects.toMatchObject({ code: '42501' });
    const columns = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toEqual(expect.arrayContaining(['nik', 'nama']));
    expect(names.filter((name) => /mail|hp|phone/.test(name))).toEqual([]);
  });

  it('G3 G6 the processor stores them and hands Fraud the customer id, NIK, name and account number', async () => {
    const fraud = new FakeFraud();
    const result = await baselineProcessor(fraud).process(
      request({ clientIdentity: { nik: person.nik, nama: person.nama } }),
    );
    expect(result.status).toBe('COMPLETED');
    expect(fraud.calls).toHaveLength(1);
    expect(fraud.calls[0]).toMatchObject({
      subject: person.customer_id,
      identity: { nik: person.nik, nama: person.nama, accountNumber: person.rekening },
    });
    expect((await db.owner.query('SELECT nik, nama FROM transactions')).rows).toEqual([
      { nik: person.nik, nama: person.nama },
    ]);
  });

  it('G3 a payment without NIK and name still gives Fraud the account number', async () => {
    const fraud = new FakeFraud();
    await baselineProcessor(fraud).process(request());
    expect(fraud.calls[0]?.identity).toEqual({ accountNumber: person.rekening });
  });

  it('G3 NFR-24 a Fraud that fails leaves no value in the log lines', async () => {
    const fraud = new FakeFraud();
    fraud.fail = true;
    const recorded = recordingLogger();
    const result = await baselineProcessor(fraud, recorded.logger).process(
      request({ clientIdentity: { nik: person.nik, nama: person.nama } }),
    );
    expect(result.status).toBe('HELD');
    expect(recorded.entries.length).toBeGreaterThan(0);
    expect(
      scanText(JSON.stringify(recorded.entries), [person], {
        service: 'transaction',
        location: 'log',
      }),
    ).toEqual([]);
  });

  it('G6 positive control: the scanner finds the stored NIK and name in the baseline dump', async () => {
    await baselineProcessor(new FakeFraud()).process(
      request({ clientIdentity: { nik: person.nik, nama: person.nama } }),
    );
    const places = (await scanDatabase(db.owner, [person], 'transaction')).map(
      (finding) => finding.location,
    );
    expect(places).toEqual(
      expect.arrayContaining(['transactions.nik', 'transactions.nama', 'transactions.customer_id']),
    );
  });
});

describe('G3 G6 proposed Transaction stores and hands over nothing of the kind', () => {
  beforeEach(async () => {
    db = await createTestDb(config, { service: 'transaction', suffix: 'g3p' });
    await migrate(db.owner, { root: migrations, mode: 'proposed' });
  });

  it('G6 the proposed table has no nik or nama column', async () => {
    const columns = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names.filter((name) => name === 'nik' || name === 'nama')).toEqual([]);
  });

  it('G3 G6 the same flow stores no identity, hands Fraud only the token, and the scan finds nothing', async () => {
    const fraud = new FakeFraud();
    const subjects = new FakeSubjects();
    const processor = new TransactionProcessor({
      repository: proposedTransactionRepository(db.app),
      clock: new FakeClock('2026-10-23T01:00:00.000Z'),
      delay: new FakeDelay(),
      fraudAmountThreshold: 1_000_000,
      waitMs: 3000,
      subjects,
      fraud,
      notifications: new FakeNotifications(),
      privacy: new FakePrivacy(),
      logger: recordingLogger().logger,
    });
    const result = await processor.process(
      request({
        customerSubjectRef: 'PSEU-00000001',
        accountSubjectRef: 'PSEU-00000002',
        clientIdentity: { nik: person.nik, nama: person.nama },
      }),
    );
    expect(result.status).toBe('COMPLETED');
    expect(fraud.calls[0]).toEqual({
      subject: 'PSEU-F0000001',
      amount: 2_000_000,
      txHour: 1,
      geohash: 'qqgu4',
    });
    expect(await scanDatabase(db.owner, [person], 'transaction')).toEqual([]);
    expect(JSON.stringify(fraud.calls)).not.toContain(person.nik);
  });
});
