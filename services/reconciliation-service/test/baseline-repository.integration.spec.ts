import { join } from 'node:path';
import { DomainError, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { compareSchemas } from '../../../tests/baseline/schema-parity';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { baselineReconciliationRepository } from '../src/baseline';
import { proposedReconciliationRepository } from '../src/proposed';
import type { ReportItem } from '../src/reconciliation';

// Seam: the baseline reconciliation-db and its repository, as the real runtime role (ADR-0006, M5-01). The items of the
// bank's report hold the account number itself, so every number here is a canary or invented.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const person = buildCanary(54);
const DATE = '2026-10-05';
const NOW = new Date('2026-10-06T00:10:00.000Z');
const REPORT: ReportItem[] = [
  { accountPseudonym: person.rekening, amount: 35_000, bankReference: 'BNK-20261005-0001' },
  { accountPseudonym: '1234567803', amount: 2_000_000, bankReference: 'BNK-20261005-0002' },
];

let db: TestDb;
let other: TestDb | undefined;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'reconciliation', suffix: 'm501b' });
  await migrate(db.owner, { root: migrations, mode: 'baseline' });
});
afterEach(async () => {
  await db.close();
  await other?.close();
  other = undefined;
});

describe('M5-01 FR-23 the baseline reconciliation schema holds the account number', () => {
  it('M5-01 FR-23 settlement_items has account_number and no pseudonym column', async () => {
    const found = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'settlement_items'`,
    );
    const names = found.rows.map((row) => row.column_name);
    expect(names).toContain('account_number');
    expect(names.filter((name) => name.includes('pseudonym'))).toEqual([]);
  });

  // Changed with the owner's decision on Tabel IV (G5, G6): a matched item of baseline also keeps the customer id, NIK and
  // name of its transaction, so those are the only columns it adds; before, the report had to be empty.
  it('M5-01 FR-23 G6 apart from the identity column and the three holder columns the schema and the grants are those of proposed', async () => {
    other = await createTestDb(config, { service: 'reconciliation', suffix: 'm501p' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    const report = await compareSchemas(
      other.owner,
      db.owner,
      { 'settlement_items.account_pseudonym': 'settlement_items.account_number' },
      { proposed: 'privpay_reconciliation_app', baseline: 'privpay_reconciliation_app' },
    );
    expect(report).toEqual({
      missing: [
        'baseline adds settlement_items.customer_id',
        'baseline adds settlement_items.nik',
        'baseline adds settlement_items.nama',
      ],
      different: [],
      indexes: [],
      grants: [],
    });
  });

  it('M5-01 FR-32 the table still refuses a value that is not an account number', async () => {
    await baselineReconciliationRepository('baseline', db.app).storeReport(DATE, [], NOW);
    await expect(
      db.owner.query(
        `INSERT INTO settlement_items (batch_id, account_number, amount, bank_reference)
         VALUES ('B-20261005', $1, 1000, 'BNK-X')`,
        ['not-a-number'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('M5-01 NFR-09 the runtime role cannot delete an item or read an audit request back', async () => {
    await expect(db.app.query('DELETE FROM settlement_items')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(db.app.query('SELECT * FROM audit_requests')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('M5-01 FR-23 the baseline reconciliation repository is the same domain over the other column', () => {
  it('M5-01 FR-23 a report is stored once: CREATED, then SAME, and a different one is a conflict', async () => {
    const repository = baselineReconciliationRepository('baseline', db.app);
    expect(await repository.storeReport(DATE, REPORT, NOW)).toBe('CREATED');
    expect(await repository.storeReport(DATE, [...REPORT].reverse(), NOW)).toBe('SAME');
    await expect(
      repository.storeReport(
        DATE,
        REPORT.map((item) => ({ ...item, amount: 1 })),
        NOW,
      ),
    ).rejects.toBeInstanceOf(DomainError);
    const stored = await db.owner.query(
      'SELECT account_number FROM settlement_items ORDER BY bank_reference',
    );
    expect(stored.rows).toEqual([
      { account_number: person.rekening },
      { account_number: '1234567803' },
    ]);
  });

  it('M5-01 FR-23 a run sees the account numbers of the report and its matches are written back', async () => {
    const repository = baselineReconciliationRepository('baseline', db.app);
    await repository.storeReport(DATE, REPORT, NOW);
    let seen: string[] = [];
    const outcome = await repository.settle(DATE, NOW, (items) => {
      seen = items.map((item) => item.accountPseudonym);
      return {
        matchedItemIds: items.filter((item) => item.amount === 35_000).map((item) => item.id),
        txCount: 1,
        totalAmount: 35_000,
        status: 'PARTIAL' as const,
      };
    });
    expect(seen).toEqual([person.rekening, '1234567803']);
    expect(outcome.status).toBe('PARTIAL');
    const flags = await db.owner.query(
      'SELECT account_number, matched FROM settlement_items ORDER BY bank_reference',
    );
    expect(flags.rows).toEqual([
      { account_number: person.rekening, matched: true },
      { account_number: '1234567803', matched: false },
    ]);
  });

  it('M5-01 FR-22 an audit request is recorded with a coded reason and the actor, as in proposed', async () => {
    const id = await baselineReconciliationRepository('baseline', db.app).recordAudit({
      transactionId: 'TX-10001',
      reasonCode: 'DISPUTE',
      actorId: 'usr-auditor',
      at: NOW,
    });
    const stored = await db.owner.query('SELECT request_id, reason_code FROM audit_requests');
    expect(stored.rows).toEqual([{ request_id: id, reason_code: 'DISPUTE' }]);
  });

  it('M5-01 ADR-0006 refuses to be built in the proposed mode', () => {
    expect(() => baselineReconciliationRepository('proposed', db.app)).toThrow(
      /PRIVACY_MODE=baseline/,
    );
  });
});

describe('M5-01 NFR-15 the positive control: in baseline the scanner finds the account number', () => {
  it('M5-01 NFR-15 FR-23 the canary account number is found in the dump, and not in proposed', async () => {
    await baselineReconciliationRepository('baseline', db.app).storeReport(DATE, REPORT, NOW);
    const found = await scanDatabase(db.owner, [person], 'reconciliation');
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'rekening',
          location: 'settlement_items.account_number',
        }),
      ]),
    );

    other = await createTestDb(config, { service: 'reconciliation', suffix: 'm501q' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    await proposedReconciliationRepository(other.app).storeReport(
      DATE,
      [{ accountPseudonym: 'PSEU-A1B2C3D4', amount: 35_000, bankReference: 'BNK-20261005-0001' }],
      NOW,
    );
    expect(await scanDatabase(other.owner, [person], 'reconciliation')).toEqual([]);
  });
});
