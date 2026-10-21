import type { Clock } from '@privpay/common';
import type { RiskConfig, RiskDecision, RiskEngine, RiskInput } from './engine';
import type { AssessmentRepository } from './repository';

export interface AssessRequest extends RiskInput {
  /** The FRAUD_DETECTION token. Fraud does not check it with Privacy; it only keys the history by it. */
  readonly pseudonym: string;
}

export interface Assessment {
  readonly riskScore: number;
  readonly decision: RiskDecision;
  readonly rulesFired: readonly string[];
  readonly rulesSkipped: readonly string[];
  readonly priorCount: number;
}

export interface FraudAssessorDeps {
  readonly repository: Pick<AssessmentRepository, 'history' | 'rules' | 'insert'>;
  readonly engine: Pick<RiskEngine, 'evaluate'>;
  readonly config: RiskConfig;
  readonly clock: Clock;
}

/** `POST /fraud/assess` without the HTTP: read the history and the rules, judge, and write one row (spec fraud 4). */
export class FraudAssessor {
  constructor(private readonly deps: FraudAssessorDeps) {}

  async assess(request: AssessRequest): Promise<Assessment> {
    const [history, rules] = await Promise.all([
      this.deps.repository.history(request.pseudonym),
      this.deps.repository.rules(),
    ]);
    const result = this.deps.engine.evaluate(request, history, rules, this.deps.config);
    await this.deps.repository.insert({
      pseudonym: request.pseudonym,
      amount: request.amount,
      txHour: request.txHour,
      geohash: request.geohash,
      priorCount: result.priorCount,
      avgPriorAmount: result.avgPriorAmount,
      riskScore: result.score,
      decision: result.decision,
      rulesFired: result.fired,
      assessedAt: this.deps.clock.now(),
    });
    return {
      riskScore: result.score,
      decision: result.decision,
      rulesFired: result.fired,
      rulesSkipped: result.skipped,
      priorCount: result.priorCount,
    };
  }
}
