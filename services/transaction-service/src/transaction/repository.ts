import type { Pool } from 'pg';

export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'HELD' | 'FAILED';
export type FraudDecision = 'ALLOW' | 'HOLD_FOR_VERIFICATION' | 'BLOCK' | 'FRAUD_UNAVAILABLE';

/** What a request stores: tokens and non-identity attributes only (FR-16, S-38). */
export interface NewTransaction {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly customerToken: string;
  readonly accountToken: string;
  readonly merchantId: string;
  readonly amount: number;
  readonly geohash: string;
  readonly createdAt: Date;
}

export interface StoredTransaction {
  readonly transactionId: string;
  readonly customerToken: string;
  readonly accountToken: string;
  readonly merchantId: string;
  readonly amount: number;
  readonly geohash: string | null;
  readonly status: TransactionStatus;
}

export interface Outcome {
  readonly status: Exclude<TransactionStatus, 'PENDING'>;
  readonly fraudDecision: FraudDecision | null;
  readonly completedAt: Date | null;
}

/** Every value is a bind parameter (CLAUDE.md). */
export const TRANSACTION_SQL = {
  merchant: 'SELECT 1 FROM merchants WHERE merchant_id = $1',
  // ADR-0009: no conflict target. A clash on the idempotency key and a clash on the transaction id both end as "no row
  // inserted"; the caller then reads by key and treats a row it cannot find as a conflict, never as a server error.
  insertPending: `INSERT INTO transactions
       (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym, merchant_id, amount, geohash,
        status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
     ON CONFLICT DO NOTHING RETURNING transaction_id`,
  findByKey: `SELECT transaction_id, customer_pseudonym, account_pseudonym, merchant_id, amount, geohash, status
     FROM transactions WHERE idempotency_key = $1`,
  // Only a row that is still PENDING can be finished; a terminal row is never rewritten.
  finish: `UPDATE transactions SET status = $2, fraud_decision = $3, completed_at = $4
     WHERE transaction_id = $1 AND status = 'PENDING'`,
} as const;

interface Row {
  transaction_id: string;
  customer_pseudonym: string;
  account_pseudonym: string;
  merchant_id: string;
  amount: string;
  geohash: string | null;
  status: TransactionStatus;
}

/** The proposed repository (ADR-0006): the store of tokens. The baseline one, with identities, is M5-01. */
export class TransactionRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async merchantExists(merchantId: string): Promise<boolean> {
    const found = await this.pool.query(TRANSACTION_SQL.merchant, [merchantId]);
    return found.rowCount === 1;
  }

  /** True when this call created the row, false when another request holds the key (or the id). */
  async insertPending(row: NewTransaction): Promise<boolean> {
    const inserted = await this.pool.query(TRANSACTION_SQL.insertPending, [
      row.transactionId,
      row.idempotencyKey,
      row.customerToken,
      row.accountToken,
      row.merchantId,
      row.amount,
      row.geohash,
      row.createdAt,
    ]);
    return inserted.rowCount === 1;
  }

  async findByKey(idempotencyKey: string): Promise<StoredTransaction | undefined> {
    const found = await this.pool.query<Row>(TRANSACTION_SQL.findByKey, [idempotencyKey]);
    const row = found.rows[0];
    if (row === undefined) return undefined;
    return {
      transactionId: row.transaction_id,
      customerToken: row.customer_pseudonym,
      accountToken: row.account_pseudonym,
      merchantId: row.merchant_id,
      // NUMERIC(18,2) comes back as text; the amounts of this platform are whole rupiah (qa C-12).
      amount: Number(row.amount),
      geohash: row.geohash,
      status: row.status,
    };
  }

  async finish(transactionId: string, outcome: Outcome): Promise<void> {
    await this.pool.query(TRANSACTION_SQL.finish, [
      transactionId,
      outcome.status,
      outcome.fraudDecision,
      outcome.completedAt,
    ]);
  }
}
