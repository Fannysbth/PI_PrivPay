import type { SubjectSql } from '../risk/repository';

/** ADR-0006, the proposed mode: the history is keyed by the FRAUD_DETECTION token. */
// Every value is a bind parameter (project rules); the column name is fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  history: `SELECT amount, geohash FROM fraud_assessments WHERE pseudonym = $1 AND assessed_at >= $2 ORDER BY assessed_at DESC, id DESC`,
  insert: `INSERT INTO fraud_assessments
       (pseudonym, amount, tx_hour, geohash, prior_count, avg_prior_amount, risk_score, decision, rules_fired, assessed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10)`,
};
