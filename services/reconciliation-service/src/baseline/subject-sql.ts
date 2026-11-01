import type { SubjectSql } from '../reconciliation/repository';

/** ADR-0006, the baseline mode: an item names its account by the number itself (spec data 9). */
// Every value is a bind parameter (project rules); the column name is fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  items: `SELECT id, account_number AS account_ref, amount, bank_reference FROM settlement_items
     WHERE batch_id = $1 ORDER BY bank_reference`,
  insertItems: `INSERT INTO settlement_items (batch_id, account_number, amount, bank_reference)
     SELECT $1, t.account, t.amount, t.reference
     FROM unnest($2::text[], $3::bigint[], $4::text[]) AS t(account, amount, reference)`,
};
