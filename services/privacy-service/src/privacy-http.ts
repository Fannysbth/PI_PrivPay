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
import {
  TRANSACTION_STATUSES,
  type TokenResult,
  type TokenService,
  type TransactionStatusService,
} from './token';

const SERVICE = 'privacy-service';
/** K-12: the largest body any endpoint of this service accepts. */
const MAX_BODY_BYTES = 16 * 1024;

const text = z.string().min(1).max(64);
// Shape only. The patterns of Pseudonym, TransactionId and the subject ids are checked again by TokenService, so a
// value that is the right kind of text but the wrong format is a 422 there, before anything is read or audited.
const identity = z.strictObject({
  subject_type: text,
  subject_id: text,
  target_service: text,
  purpose: text,
  transaction_id: text.optional(),
});
const exchange = z.strictObject({
  source_pseudonym: text,
  target_service: text,
  purpose: text,
  transaction_id: text,
});
const fromTransaction = z.strictObject({
  subject_type: text,
  transaction_id: text,
  target_service: text,
  purpose: text,
});
// The three forms have different required fields, so a body that mixes them matches none (spec privacy 4.1).
const pseudonymize = z.union([identity, exchange, fromTransaction]);
const reIssue = z.strictObject({ pseudonym: text, transaction_id: text });
const transactionStatus = z.strictObject({
  transaction_id: text,
  status: z.enum(TRANSACTION_STATUSES),
});

/** Errors of the connection to PostgreSQL, as `pg` and Node report them: the database is away, not the request wrong. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
]);
const UNREACHABLE_TEXT =
  /timeout exceeded when trying to connect|connection terminated|pool after calling end/i;

function isUnreachable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && (UNREACHABLE_CODES.has(code) || code.startsWith('08'))) {
    return true;
  }
  return typeof message === 'string' && UNREACHABLE_TEXT.test(message);
}

export interface PrivacyHttpDeps {
  readonly clock: Clock;
  readonly issuer: string;
  readonly keys: JwksKeys;
  readonly tokens: Pick<
    TokenService,
    'generate' | 'exchange' | 'generateFromTransaction' | 'reIssue'
  >;
  readonly statuses: Pick<TransactionStatusService, 'update'>;
}

function shape<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  // The size is the parsed body's own, so a declared Content-Length cannot understate it.
  if (!parsed.success || Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
    throw new DomainError('VALIDATION_ERROR');
  }
  return parsed.data;
}

const answer = (result: TokenResult) => ({
  pseudonym: result.pseudonym,
  expires_at: result.expiresAt.toISOString(),
  reused: result.reused,
});

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/**
 * What the controllers do, without the framework: prove the caller, check the shape, hand the work to the module,
 * and say that the database being away is 503 (invariant 8). `requestingService` and the actor come from the verified
 * tokens only (invariant 7); nothing in a body can name them.
 */
export class PrivacyHttp {
  constructor(private readonly deps: PrivacyHttpDeps) {}

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

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUnreachable(error)) throw new DomainError('SERVICE_UNAVAILABLE', 'database');
      throw error;
    }
  }

  async pseudonymize(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(pseudonymize, body);
    const common = {
      requestingService: who.requestingService,
      ...(who.actor === undefined ? {} : { actorId: who.actor.actorId }),
    };
    return this.run(async () => {
      if ('source_pseudonym' in input) {
        return answer(
          await this.deps.tokens.exchange({
            ...common,
            sourcePseudonym: input.source_pseudonym,
            targetService: input.target_service,
            purpose: input.purpose,
            transactionId: input.transaction_id,
          }),
        );
      }
      if ('subject_id' in input) {
        return answer(
          await this.deps.tokens.generate({
            ...common,
            subjectType: input.subject_type,
            subjectId: input.subject_id,
            targetService: input.target_service,
            purpose: input.purpose,
            ...(input.transaction_id === undefined ? {} : { transactionId: input.transaction_id }),
          }),
        );
      }
      return answer(
        await this.deps.tokens.generateFromTransaction({
          ...common,
          subjectType: input.subject_type,
          transactionId: input.transaction_id,
          targetService: input.target_service,
          purpose: input.purpose,
          ...(who.actor === undefined ? {} : { actorRole: who.actor.role }),
        }),
      );
    });
  }

  async reIssue(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(reIssue, body);
    return this.run(async () =>
      answer(
        await this.deps.tokens.reIssue({
          requestingService: who.requestingService,
          ...(who.actor === undefined ? {} : { actorId: who.actor.actorId }),
          pseudonym: input.pseudonym,
          transactionId: input.transaction_id,
        }),
      ),
    );
  }

  async transactionStatus(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(transactionStatus, body);
    const result = await this.run(() =>
      this.deps.statuses.update({
        requestingService: who.requestingService,
        transactionId: input.transaction_id,
        status: input.status,
      }),
    );
    return {
      transaction_id: result.transactionId,
      status: result.status,
      updated_at: result.updatedAt.toISOString(),
    };
  }
}
