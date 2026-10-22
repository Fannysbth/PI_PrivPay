import { DomainError } from '@privpay/common';
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
  readonly reviewedBy?: string | null;
  readonly reviewedAt?: Date | null;
}

/** One page of the HELD list (spec transaction 3.2): no token and no identity. */
export interface HeldItem {
  readonly transaction_id: string;
  readonly amount: number;
  readonly risk_score: number | null;
  readonly fraud_decision: FraudDecision | null;
  readonly created_at: string;
}

/** One COMPLETED transaction for Reconciliation (spec transaction 3.4): no token and no identity. */
export interface CompletedItem {
  readonly transaction_id: string;
  readonly amount: number;
  readonly completed_at: string;
}

/** The position after the last row of a page; the HTTP layer makes it opaque. */
export interface HeldCursor {
  readonly createdAt: string;
  readonly transactionId: string;
}

/** What a review needs to act on after it has decided: the tokens to reach the customer, and the amount to tell. */
export interface Reviewed {
  readonly transactionId: string;
  readonly customerToken: string;
  readonly accountToken: string;
  readonly amount: number;
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
       fraud_decision = COALESCE($5, fraud_decision), completed_at = COALESCE($6, completed_at),
       reviewed_by = COALESCE($7, reviewed_by), reviewed_at = COALESCE($8, reviewed_at),
       privacy_synced_at = NULL
     WHERE transaction_id = $1 AND status = $2`,
  // A new status is not heard until Privacy says so. Guarded by the status that was told, so a PATCH for an earlier
  // status (HELD) cannot mark the one that came after it (COMPLETED).
  markSynced: `UPDATE transactions SET privacy_synced_at = $3
     WHERE transaction_id = $1 AND status = $2`,
  // Rows Privacy has not heard, once a request in flight can no longer be working on them: a winner for at most the
  // pending timeout after creation, a review after its own time. Oldest first, so a long backlog drains in order.
  unsynced: `SELECT transaction_id, status FROM transactions
     WHERE privacy_synced_at IS NULL AND status <> 'PENDING' AND COALESCE(reviewed_at, created_at) < $1
     ORDER BY created_at ASC, transaction_id ASC LIMIT $2`,
  // Spec transaction 3.3: the row is locked first, so two reviews take turns and the second sees the first one's status.
  lockForReview: `SELECT status, customer_pseudonym, account_pseudonym, amount
     FROM transactions WHERE transaction_id = $1 FOR UPDATE`,
  // Spec transaction 5 step 6: only a row that is still PENDING and older than the cutoff.
  sweepPending: `UPDATE transactions SET status = 'FAILED'
     WHERE status = 'PENDING' AND created_at < $1 RETURNING transaction_id`,
  // The created_at text keeps microseconds: a cursor made from a rounded time would skip or repeat rows (keyset on
  // the pair, with the id as tie-breaker). The partial index idx_tx_held covers the status filter.
  listHeld: `SELECT transaction_id, amount, risk_score, fraud_decision,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text
     FROM transactions
     WHERE status = 'HELD'
       AND ($1::text IS NULL OR (created_at, transaction_id) > ($1::timestamptz, $2::text))
     ORDER BY created_at ASC, transaction_id ASC LIMIT $3`,
  // Re-issue in the middle of a transaction (spec transaction 5, step 5): while it is still open, PENDING or HELD.
  updateTokens: `UPDATE transactions SET customer_pseudonym = $2, account_pseudonym = $3
     WHERE transaction_id = $1 AND status IN ('PENDING', 'HELD')`,
  // Spec transaction 3.4: the day is the UTC date of completed_at, [$1, $2). The text keeps microseconds for the cursor.
  listCompleted: `SELECT transaction_id, amount,
       to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_text
     FROM transactions
     WHERE status = 'COMPLETED' AND completed_at >= $1 AND completed_at < $2
       AND ($3::text IS NULL OR (completed_at, transaction_id) > ($3::timestamptz, $4::text))
     ORDER BY completed_at ASC, transaction_id ASC LIMIT $5`,
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
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

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
      outcome.reviewedBy ?? null,
      outcome.reviewedAt ?? null,
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

  /** Failed rows come back so the caller can tell Privacy; a row a winner finished first is not among them. */
  async sweepPending(olderThan: Date): Promise<string[]> {
    assertTransition('PENDING', 'FAILED');
    const swept = await this.pool.query<{ transaction_id: string }>(TRANSACTION_SQL.sweepPending, [
      olderThan,
    ]);
    return swept.rows.map((row) => row.transaction_id);
  }

  /** Each item comes with the exact (microsecond) time text a cursor needs; the item itself shows milliseconds. */
  async listHeld(
    limit: number,
    after?: HeldCursor,
  ): Promise<{ readonly item: HeldItem; readonly createdText: string }[]> {
    const found = await this.pool.query<{
      transaction_id: string;
      amount: string;
      risk_score: string | null;
      fraud_decision: FraudDecision | null;
      created_text: string;
    }>(TRANSACTION_SQL.listHeld, [after?.createdAt ?? null, after?.transactionId ?? null, limit]);
    return found.rows.map((row) => ({
      createdText: row.created_text,
      item: {
        transaction_id: row.transaction_id,
        amount: Number(row.amount),
        risk_score: row.risk_score === null ? null : Number(row.risk_score),
        fraud_decision: row.fraud_decision,
        created_at: new Date(row.created_text).toISOString(),
      },
    }));
  }

  /**
   * Spec transaction 3.3: lock the row, require HELD, move it. `undefined` means it was not HELD (or not there), and
   * nothing was changed. The lock is held until the move is committed, so the second of two reviews waits for the
   * first and then finds a status that is no longer HELD.
   */
  async decideHeld(transactionId: string, outcome: Outcome): Promise<Reviewed | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{
        status: TransactionStatus;
        customer_pseudonym: string;
        account_pseudonym: string;
        amount: string;
      }>(TRANSACTION_SQL.lockForReview, [transactionId]);
      const row = locked.rows[0];
      if (row?.status !== 'HELD') {
        await client.query('ROLLBACK');
        return undefined;
      }
      assertTransition('HELD', outcome.status);
      const moved = await client.query(TRANSACTION_SQL.transition, [
        transactionId,
        'HELD',
        outcome.status,
        null,
        outcome.fraudDecision,
        outcome.completedAt,
        outcome.reviewedBy ?? null,
        outcome.reviewedAt ?? null,
      ]);
      // Locked and HELD a moment ago, so the move cannot miss; if it does, nothing may be reported as decided.
      if (moved.rowCount !== 1) throw new DomainError('INTERNAL_ERROR');
      await client.query('COMMIT');
      return {
        transactionId,
        customerToken: row.customer_pseudonym,
        accountToken: row.account_pseudonym,
        amount: Number(row.amount),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Records that Privacy has heard `status`; false when the row has moved on meanwhile, which says nothing about it. */
  async markPrivacySynced(
    transactionId: string,
    status: Exclude<TransactionStatus, 'PENDING'>,
    at: Date,
  ): Promise<boolean> {
    const marked = await this.pool.query(TRANSACTION_SQL.markSynced, [transactionId, status, at]);
    return marked.rowCount === 1;
  }

  async unsyncedBefore(
    cutoff: Date,
    limit: number,
  ): Promise<
    { readonly transactionId: string; readonly status: Exclude<TransactionStatus, 'PENDING'> }[]
  > {
    const found = await this.pool.query<{
      transaction_id: string;
      status: Exclude<TransactionStatus, 'PENDING'>;
    }>(TRANSACTION_SQL.unsynced, [cutoff, limit]);
    return found.rows.map((row) => ({ transactionId: row.transaction_id, status: row.status }));
  }

  /** One page of the COMPLETED transactions that fall in `[from, to)`, with the exact time text a cursor needs. */
  async listCompleted(
    from: Date,
    to: Date,
    limit: number,
    after?: { readonly at: string; readonly transactionId: string },
  ): Promise<{ readonly item: CompletedItem; readonly completedText: string }[]> {
    const found = await this.pool.query<{
      transaction_id: string;
      amount: string;
      completed_text: string;
    }>(TRANSACTION_SQL.listCompleted, [
      from,
      to,
      after?.at ?? null,
      after?.transactionId ?? null,
      limit,
    ]);
    return found.rows.map((row) => ({
      completedText: row.completed_text,
      item: {
        transaction_id: row.transaction_id,
        amount: Number(row.amount),
        completed_at: new Date(row.completed_text).toISOString(),
      },
    }));
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
