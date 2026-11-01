-- transaction-db, mode baseline (G6, N-48, Tabel IV): the NIK and the name the client sends with the payment are kept
-- beside the customer_id and the account number, as the conventional system without pseudonymisation does. Nullable:
-- a client may send neither. The e-mail and the phone have no column here (Tabel IV does not forward them).
-- Grants: 0002 gives the runtime role table-level SELECT, INSERT and UPDATE on transactions, which cover new columns,
-- so nothing is granted here and the role still has no DELETE.

ALTER TABLE transactions
  ADD COLUMN nik  VARCHAR(64),
  ADD COLUMN nama VARCHAR(200);
