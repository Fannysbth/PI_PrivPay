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
import type {
  CompletedPage,
  HeldPage,
  ProcessResult,
  TransactionProcessor,
  TransactionReads,
  TransactionReview,
} from './transaction';

const SERVICE = 'transaction-service';
/** Spec transaction 3: only the Gateway starts a transaction (AZ-26). */
const CALLER = 'API_GATEWAY';
/** Spec transaction 3.4 (K-18): only Reconciliation reads the completed transactions (AZ-29). */
const READER = 'RECONCILIATION';

// The formats the Gateway already guarantees (gateway tokenizer): checked again here, since this service does not trust
// its caller's validation. Tokens are the only link to a person and never an account number.
const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MERCHANT_ID = /^MRC-[0-9]{3,}$/;
const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;

// The two references are tokens in proposed and the customer id and the account number in baseline (N-44); the field
// names are the wire contract of the Gateway and stay the same.
const clientIdentityFields = {
  nik: z.string().max(64).optional(),
  nama: z.string().max(200).optional(),
};
const noClientIdentity: Partial<typeof clientIdentityFields> = {};
const clientIdentitySchema = z.object(clientIdentityFields);
const newTransaction = (
  refs: { customer: RegExp; account: RegExp },
  acceptClientIdentity: boolean,
) =>
  z.strictObject({
    ...(acceptClientIdentity ? clientIdentityFields : noClientIdentity),
    transaction_id: z.string().regex(TRANSACTION_ID),
    idempotency_key: z.string().regex(IDEMPOTENCY_KEY),
    customer_token: z.string().regex(refs.customer),
    account_token: z.string().regex(refs.account),
    merchant_id: z.string().regex(MERCHANT_ID),
    amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    geohash: z.string().regex(GEOHASH),
  });

// Spec transaction 3.2: both are optional, and anything else in the query is refused.
const heldQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .optional(),
  cursor: z.string().min(1).max(256).optional(),
});
// Spec transaction 3.3: a decision and a coded reason, never free text and never who decides.
const reviewBody = z.strictObject({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason_code: z.enum(['CONFIRMED_BY_CUSTOMER', 'SUSPECTED_FRAUD', 'OTHER']),
});
const isRealDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  // An impossible date (02-30) is not an instant at all or rolls over; neither is a date.
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};
// Spec transaction 3.4: a real calendar date, a page size and the cursor this service handed out; nothing else.
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const completedQuery = z.strictObject({
  date: z.string().regex(ISO_DATE).refine(isRealDate),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .optional(),
  cursor: z.string().min(1).max(256).optional(),
});
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface TransactionHttpDeps {
  readonly clock: Clock;
  readonly issuer: string;
  readonly keys: JwksKeys;
  readonly processor: Pick<TransactionProcessor, 'process'>;
  readonly review: Pick<TransactionReview, 'listHeld' | 'review'>;
  readonly reads: Pick<TransactionReads, 'completedOn' | 'detail'>;
  /** The forms of the references to the customer and the account in this mode (N-44). */
  readonly subjectRefs: { readonly customer: RegExp; readonly account: RegExp };
  /**
   * G1, G3, G6: baseline only. The Gateway passes the NIK and the name of the request on, and this edge lets them through;
   * the processor keeps them and the baseline port hands them to Fraud. Proposed refuses them like any unknown field.
   */
  readonly acceptClientIdentity?: boolean;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/**
 * What the controller does, without the framework: prove the caller, check the shape, hand the work to the processor.
 * `requesting_service` comes from the verified token only (invariant 7); no body can name it.
 */
export class TransactionHttp {
  private readonly newTransactionSchema: ReturnType<typeof newTransaction>;

  constructor(private readonly deps: TransactionHttpDeps) {
    this.newTransactionSchema = newTransaction(
      deps.subjectRefs,
      deps.acceptClientIdentity === true,
    );
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

  /** Spec transaction 3.1. The caller is decided before the body is read, so another service learns nothing from it. */
  async create(headers: AuthHeaders, body: unknown): Promise<ProcessResult> {
    const who = await this.caller(headers);
    if (who.requestingService !== CALLER) throw new DomainError('POLICY_NOT_ALLOWED');
    const parsed = this.newTransactionSchema.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const input = parsed.data;
    // The strict schema above already refused any other field; this one only reads the two that proposed never lets in.
    const sent = clientIdentitySchema.parse(input);
    const identity = sent.nik === undefined && sent.nama === undefined ? undefined : sent;
    return this.deps.processor.process({
      transactionId: input.transaction_id,
      idempotencyKey: input.idempotency_key,
      customerSubjectRef: input.customer_token,
      accountSubjectRef: input.account_token,
      merchantId: input.merchant_id,
      amount: input.amount,
      geohash: input.geohash,
      ...(identity === undefined ? {} : { clientIdentity: identity }),
    });
  }

  /**
   * The Gateway on behalf of a fraud analyst (spec transaction 3.2 and 3.3). The role is read from the verified actor
   * token only; the id returned is that token's subject, which is what `reviewed_by` will hold (invariant 7).
   */
  private async analyst(headers: AuthHeaders): Promise<string> {
    const who = await this.caller(headers);
    if (who.requestingService !== CALLER) throw new DomainError('POLICY_NOT_ALLOWED');
    if (who.actor?.role !== 'fraud_analyst') throw new DomainError('FORBIDDEN_ROLE');
    return who.actor.actorId;
  }

  /** Spec transaction 3.2. */
  async held(headers: AuthHeaders, query: unknown): Promise<HeldPage> {
    await this.analyst(headers);
    const parsed = heldQuery.safeParse(query);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const limit = parsed.data.limit === undefined ? DEFAULT_LIMIT : Number(parsed.data.limit);
    if (limit < 1 || limit > MAX_LIMIT) throw new DomainError('VALIDATION_ERROR');
    return this.deps.review.listHeld({
      limit,
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    });
  }

  /** Spec transaction 3.3. The reason code is checked but not kept: the table has no column for it (PRD 11). */
  async decide(headers: AuthHeaders, transactionId: string, body: unknown) {
    const reviewedBy = await this.analyst(headers);
    const parsed = reviewBody.safeParse(body);
    if (!parsed.success || !TRANSACTION_ID.test(transactionId)) {
      throw new DomainError('VALIDATION_ERROR');
    }
    return this.deps.review.review({
      transactionId,
      decision: parsed.data.decision,
      reviewedBy,
    });
  }

  /** Spec transaction 3.4 (AZ-29): the caller is Reconciliation, by its service token alone. */
  async completed(headers: AuthHeaders, query: unknown): Promise<CompletedPage> {
    const who = await this.caller(headers);
    if (who.requestingService !== READER) throw new DomainError('POLICY_NOT_ALLOWED');
    const parsed = completedQuery.safeParse(query);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const limit = parsed.data.limit === undefined ? DEFAULT_LIMIT : Number(parsed.data.limit);
    if (limit < 1 || limit > MAX_LIMIT) throw new DomainError('VALIDATION_ERROR');
    return this.deps.reads.completedOn(parsed.data.date, {
      limit,
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    });
  }

  /** Spec transaction 3.4 (AZ-30): one transaction for an audit, asked for by Reconciliation alone. */
  async detail(headers: AuthHeaders, transactionId: string) {
    const who = await this.caller(headers);
    if (who.requestingService !== READER) throw new DomainError('POLICY_NOT_ALLOWED');
    if (!TRANSACTION_ID.test(transactionId)) throw new DomainError('VALIDATION_ERROR');
    return this.deps.reads.detail(transactionId);
  }
}
