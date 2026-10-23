import type { SubjectSql } from '../transaction/repository';

/** ADR-0006, the baseline mode: the subject is stored as the identity itself (spec data 9). */
// Every value is a bind parameter (CLAUDE.md); the column names are fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  insertPending: `INSERT INTO transactions
       (transaction_id, idempotency_key, customer_id, account_number, merchant_id, amount, geohash,
        status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
     ON CONFLICT DO NOTHING RETURNING transaction_id`,
  findByKey: `SELECT transaction_id, customer_id AS customer_ref, account_number AS account_ref, merchant_id, amount, geohash, status
     FROM transactions WHERE idempotency_key = $1`,
  lockForReview: `SELECT status, customer_id AS customer_ref, account_number AS account_ref, amount
     FROM transactions WHERE transaction_id = $1 FOR UPDATE`,
  updateTokens: `UPDATE transactions SET customer_id = $2, account_number = $3
     WHERE transaction_id = $1 AND status IN ('PENDING', 'HELD')`,
  findDetailWithAccount: `SELECT transaction_id, amount, status, created_at, completed_at, account_number AS account_ref
     FROM transactions WHERE transaction_id = $1`,
  findById: `SELECT transaction_id, customer_id AS customer_ref, account_number AS account_ref, merchant_id, amount, geohash, status
     FROM transactions WHERE transaction_id = $1`,
};
