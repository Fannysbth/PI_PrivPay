import type { Pool } from 'pg';
import { assertTransition } from './status-machine';

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
  readonly riskScore?: number | null;
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
  // The move is guarded by the status the caller saw ($2): a row that someone else moved meanwhile is not rewritten,
  // so a terminal row never changes (spec transaction 4). A value that is NULL here keeps what the row has.
  transition: `UPDATE transactions SET status = $3, risk_score = COALESCE($4, risk_score),
       fraud_decision = COALESCE($5, fraud_decision), completed_at = COALESCE($6, completed_at)
     WHERE transaction_id = $1 AND status = $2`,
  // Re-issue in the middle of a transaction (spec transaction 5, step 5): only while it is still being decided.
  updateTokens: `UPDATE transactions SET customer_pseudonym = $2, account_pseudonym = $3
     WHERE transaction_id = $1 AND status = 'PENDING'`,
  findById: `SELECT transaction_id, customer_pseudonym, account_pseudonym, merchant_id, amount, geohash, status
     FROM transactions WHERE transaction_id = $1`,
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
    return row === undefined ? undefined : toStored(row);
  }

  /** True when this call moved the row; false when it was no longer in `from` (someone else moved it first). */
  async transition(
    transactionId: string,
    from: TransactionStatus,
    outcome: Outcome,
  ): Promise<boolean> {
    assertTransition(from, outcome.status);
    const moved = await this.pool.query(TRANSACTION_SQL.transition, [
      transactionId,
      from,
      outcome.status,
      outcome.riskScore ?? null,
      outcome.fraudDecision,
      outcome.completedAt,
    ]);
    return moved.rowCount === 1;
  }

  /** The winner's end of the work: only a row that is still PENDING is finished. False means the sweeper was first. */
  finish(transactionId: string, outcome: Outcome): Promise<boolean> {
    return this.transition(transactionId, 'PENDING', outcome);
  }

  async updateTokens(
    transactionId: string,
    tokens: { readonly customerToken: string; readonly accountToken: string },
  ): Promise<void> {
    await this.pool.query(TRANSACTION_SQL.updateTokens, [
      transactionId,
      tokens.customerToken,
      tokens.accountToken,
    ]);
  }

  async findById(transactionId: string): Promise<StoredTransaction | undefined> {
    const found = await this.pool.query<Row>(TRANSACTION_SQL.findById, [transactionId]);
    const row = found.rows[0];
    return row === undefined ? undefined : toStored(row);
  }
}

function toStored(row: Row): StoredTransaction {
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
