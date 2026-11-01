-- fraud-db, mode baseline (G3, G6, Tabel IV): Transaction hands Fraud the NIK, the name and the account number beside
-- the customer_id, and the conventional system keeps what it is given. Nullable: a payment may come without a NIK or a
-- name. The score never reads these columns. The e-mail and the phone have no column here (Tabel IV does not forward them).
-- Grants: 0002 gives the runtime role table-level SELECT and INSERT on fraud_assessments, which cover new columns, so
-- nothing is granted here and the rows stay append-only.

ALTER TABLE fraud_assessments
  ADD COLUMN nik            VARCHAR(64),
  ADD COLUMN nama           VARCHAR(200),
  ADD COLUMN account_number VARCHAR(20);
