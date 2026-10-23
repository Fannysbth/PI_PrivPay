import {
  authenticate,
  DomainError,
  parseBearer,
  unverifiedKid,
  type AuthHeaders,
  type Authenticated,
  type Clock,
  type JwksKeys,
} from '@privpay/common';
import { z } from 'zod';
import type { FraudAssessor } from './risk';

const SERVICE = 'fraud-service';
/** Spec fraud 3: only Transaction asks for an assessment (AZ-31). */
const CALLER = 'TRANSACTION';

const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;

// The service takes a reference to the customer and numbers; a field of any other name, an identity among them, is
// refused (S-40). The reference is a token in proposed and the customer id in baseline (N-44), so the form is the mode's.
const assessBody = (customer: RegExp) =>
  z.strictObject({
    pseudonym: z.string().regex(customer),
    amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    tx_hour: z.number().int().min(0).max(23),
    geohash: z.string().regex(GEOHASH),
  });

export interface FraudHttpDeps {
  readonly clock: Clock;
  readonly issuer: string;
  readonly keys: JwksKeys;
  readonly assessor: Pick<FraudAssessor, 'assess'>;
  /** The form of the reference to the customer in this mode (N-44). */
  readonly customerRef: RegExp;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/**
 * What the controller does, without the framework: prove the caller, check the shape, hand the work to the assessor.
 * `requesting_service` comes from the verified token only (invariant 7); no body can name it.
 */
export class FraudHttp {
  private readonly assessSchema: ReturnType<typeof assessBody>;

  constructor(private readonly deps: FraudHttpDeps) {
    this.assessSchema = assessBody(deps.customerRef);
  }

  private async caller(headers: AuthHeaders): Promise<Authenticated> {
    // The keys are loaded for the key id a token claims before its signature is checked; an unknown id gains nothing.
    const bearer = parseBearer(single(headers['authorization']));
    const actor = single(headers['x-actor-token']);
    if (bearer !== undefined) await this.deps.keys.ensure(unverifiedKid(bearer));
    if (actor !== undefined) await this.deps.keys.ensure(unverifiedKid(actor));
    return authenticate(headers, {
      clock: this.deps.clock,
      issuer: this.deps.issuer,
      service: SERVICE,
      resolveKey: (kid) => this.deps.keys.resolveKey(kid),
    });
  }

  /** Spec fraud 3. The caller is decided before the body is read, so another service learns nothing from it. */
  async assess(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    if (who.requestingService !== CALLER) throw new DomainError('POLICY_NOT_ALLOWED');
    const parsed = this.assessSchema.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const input = parsed.data;
    const result = await this.deps.assessor.assess({
      pseudonym: input.pseudonym,
      amount: input.amount,
      txHour: input.tx_hour,
      geohash: input.geohash,
    });
    return {
      risk_score: result.riskScore,
      decision: result.decision,
      rules_fired: result.rulesFired,
      rules_skipped: result.rulesSkipped,
      prior_count: result.priorCount,
    };
  }
}
