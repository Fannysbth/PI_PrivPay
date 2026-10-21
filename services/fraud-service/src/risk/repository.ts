import type { Pool } from 'pg';
import type { PriorAssessment, RiskDecision, RuleRow } from './engine';

/** What one assessment leaves in the table: the token and numbers, no identity and no transaction (FR-18). */
export interface NewAssessment {
  readonly pseudonym: string;
  readonly amount: number;
  readonly txHour: number;
  readonly geohash: string;
  readonly priorCount: number;
  readonly avgPriorAmount: number | null;
  readonly riskScore: number;
  readonly decision: RiskDecision;
  readonly rulesFired: readonly string[];
  readonly assessedAt: Date;
}

/** Every value is a bind parameter (CLAUDE.md). */
export const ASSESSMENT_SQL = {
  // PRD 10: the whole history of the token, newest first. The 30 days come from the age of the token, not from here.
  history: `SELECT amount, geohash FROM fraud_assessments WHERE pseudonym = $1 ORDER BY assessed_at DESC, id DESC`,
  rules: 'SELECT rule, parameter, weight, active FROM risk_rules ORDER BY rule',
  insert: `INSERT INTO fraud_assessments
       (pseudonym, amount, tx_hour, geohash, prior_count, avg_prior_amount, risk_score, decision, rules_fired, assessed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10)`,
} as const;

interface HistoryRow {
  amount: string;
  geohash: string | null;
}

/** The proposed adapter of the seam (spec fraud 2): the key is the pseudonym. The baseline one, by customer, is M5-01. */
export class AssessmentRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async history(pseudonym: string): Promise<PriorAssessment[]> {
    const found = await this.pool.query<HistoryRow>(ASSESSMENT_SQL.history, [pseudonym]);
    // NUMERIC(18,2) comes back as text; the amounts of this platform are whole rupiah (qa C-12).
    return found.rows.map((row) => ({ amount: Number(row.amount), geohash: row.geohash }));
  }

  async rules(): Promise<RuleRow[]> {
    const found = await this.pool.query<RuleRow>(ASSESSMENT_SQL.rules);
    return found.rows;
  }

  async insert(row: NewAssessment): Promise<void> {
    await this.pool.query(ASSESSMENT_SQL.insert, [
      row.pseudonym,
      row.amount,
      row.txHour,
      row.geohash,
      row.priorCount,
      row.avgPriorAmount,
      row.riskScore,
      row.decision,
      [...row.rulesFired],
      row.assessedAt,
    ]);
  }
}
