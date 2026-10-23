import type { SubjectSql } from '../transaction/repository';

/** ADR-0006, the proposed mode: the subject is stored as the tokens of this service. */
// Every value is a bind parameter (CLAUDE.md); the column names are fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  insertPending: `INSERT INTO transactions
       (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym, merchant_id, amount, geohash,
        status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
     ON CONFLICT DO NOTHING RETURNING transaction_id`,
  findByKey: `SELECT transaction_id, customer_pseudonym AS customer_ref, account_pseudonym AS account_ref, merchant_id, amount, geohash, status
     FROM transactions WHERE idempotency_key = $1`,
  lockForReview: `SELECT status, customer_pseudonym AS customer_ref, account_pseudonym AS account_ref, amount
     FROM transactions WHERE transaction_id = $1 FOR UPDATE`,
  updateTokens: `UPDATE transactions SET customer_pseudonym = $2, account_pseudonym = $3
     WHERE transaction_id = $1 AND status IN ('PENDING', 'HELD')`,
  findById: `SELECT transaction_id, customer_pseudonym AS customer_ref, account_pseudonym AS account_ref, merchant_id, amount, geohash, status
     FROM transactions WHERE transaction_id = $1`,
};
