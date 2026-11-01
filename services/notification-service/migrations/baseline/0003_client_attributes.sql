-- notification-db, mode baseline (G4, G6, Tabel IV): the Gateway holds the registration form and hands Notification the NIK,
-- the name and the account number beside the customer_id and the phone, and the conventional system keeps what it is
-- given. Nullable: a registration may come without them. A message never reads these columns. The e-mail has no column
-- here (Tabel IV does not forward it, G2).
-- Grants: 0002 gives the runtime role table-level SELECT, INSERT and UPDATE on contact_registry, which cover new
-- columns, so nothing is granted here and the role still has no DELETE.

ALTER TABLE contact_registry
  ADD COLUMN nik            VARCHAR(64),
  ADD COLUMN nama           VARCHAR(200),
  ADD COLUMN account_number VARCHAR(20);
