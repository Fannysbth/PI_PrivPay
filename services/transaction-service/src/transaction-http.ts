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
import type { ProcessResult, TransactionProcessor } from './transaction';

const SERVICE = 'transaction-service';
/** Spec transaction 3: only the Gateway starts a transaction (AZ-26). */
const CALLER = 'API_GATEWAY';

// The formats the Gateway already guarantees (gateway tokenizer): checked again here, since this service does not trust
// its caller's validation. Tokens are the only link to a person and never an account number.
const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const MERCHANT_ID = /^MRC-[0-9]{3,}$/;
const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;

const newTransaction = z.strictObject({
  transaction_id: z.string().regex(TRANSACTION_ID),
  idempotency_key: z.string().regex(IDEMPOTENCY_KEY),
  customer_token: z.string().regex(PSEUDONYM),
  account_token: z.string().regex(PSEUDONYM),
  merchant_id: z.string().regex(MERCHANT_ID),
  amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  geohash: z.string().regex(GEOHASH),
});

export interface TransactionHttpDeps {
  readonly clock: Clock;
  readonly issuer: string;
  readonly keys: JwksKeys;
  readonly processor: Pick<TransactionProcessor, 'process'>;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/**
 * What the controller does, without the framework: prove the caller, check the shape, hand the work to the processor.
 * `requesting_service` comes from the verified token only (invariant 7); no body can name it.
 */
export class TransactionHttp {
  constructor(private readonly deps: TransactionHttpDeps) {}

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

  /** Spec transaction 3.1. The caller is decided before the body is read, so another service learns nothing from it. */
  async create(headers: AuthHeaders, body: unknown): Promise<ProcessResult> {
    const who = await this.caller(headers);
    if (who.requestingService !== CALLER) throw new DomainError('POLICY_NOT_ALLOWED');
    const parsed = newTransaction.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const input = parsed.data;
    return this.deps.processor.process({
      transactionId: input.transaction_id,
      idempotencyKey: input.idempotency_key,
      customerToken: input.customer_token,
      accountToken: input.account_token,
      merchantId: input.merchant_id,
      amount: input.amount,
      geohash: input.geohash,
    });
  }
}
