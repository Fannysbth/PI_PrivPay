import type { SubjectSql } from '../transaction/repository';

/** ADR-0006, the baseline mode: the subject is stored as the identity itself (spec data 9). */
// Every value is a bind parameter (project rules); the column names are fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  storesClientIdentity: true,
  insertPending: `INSERT INTO transactions
       (transaction_id, idempotency_key, customer_id, account_number, merchant_id, amount, geohash,
        status, created_at, nik, nama)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)
     ON CONFLICT DO NOTHING RETURNING transaction_id`,
  findByKey: `SELECT transaction_id, customer_id AS customer_ref, account_number AS account_ref, merchant_id, amount, geohash, status,
       nik AS holder_nik, nama AS holder_nama
     FROM transactions WHERE idempotency_key = $1`,
  lockForReview: `SELECT status, customer_id AS customer_ref, account_number AS account_ref, amount
     FROM transactions WHERE transaction_id = $1 FOR UPDATE`,
  updateTokens: `UPDATE transactions SET customer_id = $2, account_number = $3
     WHERE transaction_id = $1 AND status IN ('PENDING', 'HELD')`,
  findDetailWithAccount: `SELECT transaction_id, amount, status, created_at, completed_at, account_number AS account_ref,
       customer_id AS customer_ref, nik AS holder_nik, nama AS holder_nama
     FROM transactions WHERE transaction_id = $1`,
  // G5, Tabel IV: Reconciliation reads the customer id, the NIK, the name and the account number as stored. Same page
  // rules as the generic list (the day is the UTC date of completed_at, keyset on the pair).
  listCompletedWithIdentity: `SELECT transaction_id, amount, customer_id, account_number, nik, nama,
       to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_text
     FROM transactions
     WHERE status = 'COMPLETED' AND completed_at >= $1 AND completed_at < $2
       AND ($3::text IS NULL OR (completed_at, transaction_id) > ($3::timestamptz, $4::text))
     ORDER BY completed_at ASC, transaction_id ASC LIMIT $5`,
  findById: `SELECT transaction_id, customer_id AS customer_ref, account_number AS account_ref, merchant_id, amount, geohash, status,
       nik AS holder_nik, nama AS holder_nama
     FROM transactions WHERE transaction_id = $1`,
};
