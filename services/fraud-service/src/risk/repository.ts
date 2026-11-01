import type { Pool } from 'pg';
import type { PriorAssessment, RiskDecision, RuleRow } from './engine';

/**
 * The attributes of the customer the edge handed over beside the reference (G3). They are kept as they came, by a
 * mode whose table has the columns for them (G6), and are never an input of the score.
 */
export interface ClientAttributes {
  readonly nik?: string;
  readonly nama?: string;
  readonly accountNumber?: string;
}

/** What one assessment leaves in the table: the reference and numbers, no transaction (FR-18); the attributes only where a mode keeps them. */
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
  readonly attributes?: ClientAttributes;
}

/** Every value is a bind parameter (project rules). */
export const ASSESSMENT_SQL = {
  rules: 'SELECT rule, parameter, weight, active FROM risk_rules ORDER BY rule',
} as const;

/**
 * ADR-0006: the two statements that name the column of the subject, the only SQL that differs between the modes. The
 * folder of each mode (`proposed/`, `baseline/`) supplies them; the repository below is one code for both.
 */
export interface SubjectSql {
  // G6: true when `insert` has three more parameters, `$11` (nik), `$12` (nama) and `$13` (account number). pg refuses a
  // statement bound to more values than it names, so they are bound only for the SQL that has the columns.
  readonly storesClientAttributes: boolean;
  // PRD 10 + N-45: the history of the subject from $2 on (FRAUD_HISTORY_DAYS), newest first. The window is stated here
  // and not left to the age of the token, so both modes judge the same transactions.
  readonly history: string;
  readonly insert: string;
}

interface HistoryRow {
  amount: string;
  geohash: string | null;
}

/**
 * The repository of the seam (spec fraud 2, ADR-0006). It knows no mode: the key of the history is the pseudonym in
 * proposed and the `customer_id` in baseline, and the SQL that names it is handed in by the adapter of the mode.
 */
export class AssessmentRepository {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly subject: SubjectSql,
  ) {}

  async history(pseudonym: string, since: Date): Promise<PriorAssessment[]> {
    const found = await this.pool.query<HistoryRow>(this.subject.history, [pseudonym, since]);
    // NUMERIC(18,2) comes back as text; the amounts of this platform are whole rupiah (qa C-12).
    return found.rows.map((row) => ({ amount: Number(row.amount), geohash: row.geohash }));
  }

  async rules(): Promise<RuleRow[]> {
    const found = await this.pool.query<RuleRow>(ASSESSMENT_SQL.rules);
    return found.rows;
  }

  async insert(row: NewAssessment): Promise<void> {
    const values: unknown[] = [
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
    ];
    if (this.subject.storesClientAttributes) {
      values.push(
        row.attributes?.nik ?? null,
        row.attributes?.nama ?? null,
        row.attributes?.accountNumber ?? null,
      );
    }
    await this.pool.query(this.subject.insert, values);
  }
}
