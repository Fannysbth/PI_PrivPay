/** One row of `risk_rules` (PRD 11): the weight, the parameter text and whether the rule counts. */
export interface RuleRow {
  readonly rule: string;
  readonly parameter: string;
  readonly weight: number;
  readonly active: boolean;
}

/** What an earlier assessment of the same token tells (newest first). Only these two fields are read. */
export interface PriorAssessment {
  readonly amount: number;
  readonly geohash: string | null;
}

export interface RiskInput {
  readonly amount: number;
  /** Hour of the day in UTC, 0..23. */
  readonly txHour: number;
  readonly geohash: string;
}

/** Values that come from the environment, never from a literal here (CLAUDE.md, K-20). */
export interface RiskConfig {
  readonly amountThreshold: number;
  /** From this hour on the night starts (22). */
  readonly oddHourStart: number;
  /** Until this hour the night lasts (6). */
  readonly oddHourEnd: number;
  readonly holdThreshold: number;
  readonly blockThreshold: number;
}

export type RiskDecision = 'ALLOW' | 'HOLD_FOR_VERIFICATION' | 'BLOCK';

export interface RiskResult {
  readonly score: number;
  readonly decision: RiskDecision;
  readonly fired: readonly string[];
  readonly skipped: readonly string[];
  readonly priorCount: number;
  /** Average amount of the history; null at a cold start. */
  readonly avgPriorAmount: number | null;
}

export const RULES = {
  amount: 'AMOUNT_OVER_THRESHOLD',
  hour: 'ODD_HOUR_OUTSIDE_06_22',
  average: 'AMOUNT_OVER_3X_AVG',
  location: 'NEW_LOCATION_VS_LAST_3',
} as const;

/** The three latest places are the profile of a place (PRD 10). */
const KNOWN_PLACES = 3;

/**
 * The weighted rules of PRD 10 (spec fraud 4), pure: the history and the table are handed in, so the cases can be
 * listed in a table and nothing is read from a clock or a database. A rule that is not active, or not in the table,
 * is skipped and adds nothing (K-20).
 */
export class RiskEngine {
  evaluate(
    input: RiskInput,
    history: readonly PriorAssessment[],
    rules: readonly RuleRow[],
    config: RiskConfig,
  ): RiskResult {
    const byName = new Map(rules.map((row) => [row.rule, row]));
    const fired: string[] = [];
    const skipped: string[] = [];
    let score = 0;
    // A rule counts only when its row is there and active; the weight is the row's, not a literal.
    const apply = (name: string, holds: () => boolean): void => {
      const row = byName.get(name);
      if (row?.active !== true) {
        skipped.push(name);
        return;
      }
      if (holds()) {
        score += row.weight;
        fired.push(name);
      }
    };

    const priorCount = history.length;
    apply(RULES.amount, () => input.amount >= config.amountThreshold);
    apply(
      RULES.hour,
      () => input.txHour < config.oddHourEnd || input.txHour >= config.oddHourStart,
    );

    let avgPriorAmount: number | null = null;
    if (priorCount === 0) {
      // Cold start: no profile yet, so the two rules about the profile cannot say anything.
      skipped.push(RULES.average, RULES.location);
    } else {
      const total = history.reduce((sum, prior) => sum + prior.amount, 0);
      avgPriorAmount = Math.round((total / priorCount) * 100) / 100;
      apply(RULES.average, () => {
        // amount > multiplier x (total / count), without the division: whole rupiah stay exact.
        return input.amount * priorCount > multiplierOf(byName.get(RULES.average)) * total;
      });
      apply(
        RULES.location,
        () => !history.slice(0, KNOWN_PLACES).some((prior) => prior.geohash === input.geohash),
      );
    }

    return {
      score,
      decision: decide(score, config),
      fired,
      skipped,
      priorCount,
      avgPriorAmount,
    };
  }
}

function decide(score: number, config: RiskConfig): RiskDecision {
  if (score >= config.blockThreshold) return 'BLOCK';
  if (score >= config.holdThreshold) return 'HOLD_FOR_VERIFICATION';
  return 'ALLOW';
}

/** The parameter of AMOUNT_OVER_3X_AVG is the multiplier ("3.00"). A table that says otherwise is a fault, not a guess. */
function multiplierOf(row: RuleRow | undefined): number {
  const value = Number(row?.parameter);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('the multiplier of AMOUNT_OVER_3X_AVG must be a positive number');
  }
  return value;
}
