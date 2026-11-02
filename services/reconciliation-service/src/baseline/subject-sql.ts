import type { SubjectSql } from '../reconciliation/repository';

/** ADR-0006, the baseline mode: an item names its account by the number itself (spec data 9). */
// Every value is a bind parameter (project rules); the column name is fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  items: `SELECT id, account_number AS account_ref, amount, bank_reference FROM settlement_items
     WHERE batch_id = $1 ORDER BY bank_reference`,
  insertItems: `INSERT INTO settlement_items (batch_id, account_number, amount, bank_reference)
     SELECT $1, t.account, t.amount, t.reference
     FROM unnest($2::text[], $3::bigint[], $4::text[]) AS t(account, amount, reference)`,
  // G5, G6 (Tabel IV): a matched item keeps the customer id, NIK and name of the transaction it was paired with.
  storeHolders: {
    clear: `UPDATE settlement_items SET customer_id = NULL, nik = NULL, nama = NULL WHERE batch_id = $1`,
    set: `UPDATE settlement_items AS i SET customer_id = h.customer_id, nik = h.nik, nama = h.nama
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS h(id, customer_id, nik, nama)
       WHERE i.batch_id = $1 AND i.id = h.id`,
  },
};
