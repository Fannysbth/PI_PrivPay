import { join } from 'node:path';
import { DomainError, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { canTransition, TransactionRepository, type TransactionStatus } from '../src/transaction';

// Seam: the state machine of spec transaction 4 as the repository enforces it, on the real database with the real
// runtime role. Every pair of (from, to) is tried, not only the legal ones. Needs PostgreSQL and bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const STATUSES: readonly TransactionStatus[] = ['PENDING', 'HELD', 'COMPLETED', 'FAILED'];
const LEGAL = new Set([
  'PENDING>HELD',
  'PENDING>COMPLETED',
  'PENDING>FAILED',
  'HELD>COMPLETED',
  'HELD>FAILED',
]);
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');
const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

let db: TestDb;
let repository: TransactionRepository;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'transaction', suffix: 'm402sm' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  repository = new TransactionRepository(db.app);
});
afterEach(async () => {
  await db.close();
});

async function seed(status: TransactionStatus): Promise<void> {
  await db.owner.query(
    `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
        merchant_id, amount, geohash, status, completed_at)
      VALUES ('TX-3001', $1, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', 35000, 'qqgu4', $2, NULL)`,
    [KEY, status],
  );
}
const statusOf = async (): Promise<string> =>
  (await db.owner.query<{ status: string }>('SELECT status FROM transactions')).rows[0]?.status ??
  '';

describe('M4-02 spec transaction 4 the state machine', () => {
  it.each(PAIRS)(
    'M4-02 canTransition(%s, %s) is true only for the five moves of the spec',
    (from, to) => {
      expect(canTransition(from, to)).toBe(LEGAL.has(`${from}>${to}`));
    },
  );

  it.each(PAIRS)(
    'M4-02 repository moves %s to %s only if the spec has that move',
    async (from, to) => {
      await seed(from);
      const attempt = repository.transition('TX-3001', from, {
        status: to as Exclude<TransactionStatus, 'PENDING'>,
        fraudDecision: null,
        completedAt: null,
      });
      if (LEGAL.has(`${from}>${to}`)) {
        await expect(attempt).resolves.toBe(true);
        expect(await statusOf()).toBe(to);
      } else {
        // An illegal pair is refused before any SQL: the row is exactly what it was.
        await expect(attempt).rejects.toBeInstanceOf(DomainError);
        expect(await statusOf()).toBe(from);
      }
    },
  );

  it.each(['COMPLETED', 'FAILED'] as const)(
    'M4-02 a %s row is never rewritten, even by a caller that believes it is still HELD or PENDING',
    async (terminal) => {
      await seed(terminal);
      for (const believed of ['PENDING', 'HELD'] as const) {
        await expect(
          repository.transition('TX-3001', believed, {
            status: 'FAILED',
            fraudDecision: 'BLOCK',
            completedAt: null,
          }),
        ).resolves.toBe(false);
        await expect(
          repository.transition('TX-3001', believed, {
            status: 'COMPLETED',
            fraudDecision: 'ALLOW',
            completedAt: new Date(),
          }),
        ).resolves.toBe(false);
      }
      const [row] = (await db.owner.query<Record<string, unknown>>('SELECT * FROM transactions'))
        .rows;
      expect(row).toMatchObject({ status: terminal, fraud_decision: null, completed_at: null });
    },
  );
});
