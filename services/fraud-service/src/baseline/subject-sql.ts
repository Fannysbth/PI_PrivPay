import type { SubjectSql } from '../risk/repository';

/** ADR-0006, the baseline mode: the history is keyed by the customer_id itself (spec data 9). */
// Every value is a bind parameter (CLAUDE.md); the column name is fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  history: `SELECT amount, geohash FROM fraud_assessments WHERE customer_id = $1 AND assessed_at >= $2 ORDER BY assessed_at DESC, id DESC`,
  insert: `INSERT INTO fraud_assessments
       (customer_id, amount, tx_hour, geohash, prior_count, avg_prior_amount, risk_score, decision, rules_fired, assessed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10)`,
};
