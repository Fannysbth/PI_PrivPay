-- reconciliation-db, mode baseline only (G5, G6, Tabel IV): a matched bank line keeps who it belongs to, the way a
-- conventional system records it. The account number is already in the item (it is what the bank reported). Nullable: an
-- item that no transaction matched, or a transaction stored without NIK and name, leaves them empty. The grants of 0002
-- are table level (SELECT, INSERT, UPDATE on settlement_items), so they cover the new columns; nothing is ever deleted.
ALTER TABLE settlement_items
  ADD COLUMN customer_id VARCHAR(16),
  ADD COLUMN nik         VARCHAR(64),
  ADD COLUMN nama        VARCHAR(200);
