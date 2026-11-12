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
import type { AuditLogService, AuditPage } from './audit';
import type { DePseudonymizeService, DisclosureService } from './disclosure';
import type { IdentityVault } from './identity';
import type { RevocationService } from './revocation';
import {
  MAX_BATCH,
  TRANSACTION_STATUSES,
  type TokenResult,
  type TokenService,
  type TransactionStatusService,
} from './token';

const SERVICE = 'privacy-service';
/** K-12: the largest body any endpoint of this service accepts. The shared parser's own limit is wider (100 kB). */
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
// ADR-0019: the pair of one payment. Only the identity form; the rest (types, formats) is checked again by TokenService.
const pseudonymizeBatch = z.strictObject({ requests: z.array(identity).min(1).max(MAX_BATCH) });
const reIssue = z.strictObject({ pseudonym: text, transaction_id: text });
const resolveDomain = z.strictObject({ notif_token: text });
const noBody = z.strictObject({});
// Shape only: DePseudonymizeService checks the formats again (spec privacy 4.3, 9.4 order).
const dePseudonymize = z.strictObject({ pseudonym: text, purpose: text, disclosure_id: text });
// Shape only: DisclosureService checks the case reference, the basis and the attributes (spec privacy 9.4 order).
const disclosureRequest = z.strictObject({
  audit_token: text,
  basis: text,
  case_ref: text,
  attributes: z.array(text).max(16),
});

// Query strings of the audit endpoints (spec privacy 4.8). Shape only; AuditLogService checks the formats again.
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const number = z.string().regex(/^[0-9]{1,4}$/);
const instant = z
  .string()
  .regex(ISO_INSTANT)
  .transform((value) => new Date(value));
const paging = { limit: number.optional(), cursor: z.string().regex(CURSOR).optional() };
const auditList = z.strictObject({
  ...paging,
  service: text.optional(),
  status: text.optional(),
  reason: text.optional(),
  pseudonym: text.optional(),
  transaction_id: text.optional(),
  action: text.optional(),
  disclosure_id: text.optional(),
  from: instant.optional(),
  to: instant.optional(),
});
const auditTimeline = z.strictObject(paging);
const auditSummary = z.strictObject({ from: instant.optional(), to: instant.optional() });
const revokeSubject = z.strictObject({ subject_type: text, subject_id: text });
const transactionStatus = z.strictObject({
  transaction_id: text,
  status: z.enum(TRANSACTION_STATUSES),
});

// Shape only; the patterns of the five values are checked again by IdentityVault (spec privacy 4.9).
const storeIdentity = z.strictObject({
  customer_id: text,
  nik: text,
  nama: z.string().min(1).max(100),
  hp: text,
  rekening: text,
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
// SQLSTATE classes 08 (connection exception) and 53 (insufficient resources, for example too many connections).
const SQLSTATE_CLASSES = /^(08|53)/;
const UNREACHABLE_TEXT =
  /timeout exceeded when trying to connect|connection terminated|pool after calling end/i;

export function isUnreachable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && (UNREACHABLE_CODES.has(code) || SQLSTATE_CLASSES.test(code))) {
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
    | 'generate'
    | 'generateBatch'
    | 'exchange'
    | 'generateFromTransaction'
    | 'reIssue'
    | 'resolveDomain'
  >;
  readonly statuses: Pick<TransactionStatusService, 'update'>;
  readonly vault: Pick<IdentityVault, 'store'>;
  readonly auditLog: Pick<AuditLogService, 'list' | 'timeline' | 'summary'>;
  readonly disclosure: Pick<DisclosureService, 'request' | 'approve' | 'reject'>;
  readonly opening: Pick<DePseudonymizeService, 'open'>;
  readonly revocation: Pick<RevocationService, 'revokeToken' | 'revokeSubject'>;
}

function shape<T>(schema: z.ZodType<T>, headers: AuthHeaders, body: unknown): T {
  // The declared length: a valid body padded with white space is small once parsed but still over the limit.
  const declared = Number(single(headers['content-length']));
  const parsed = schema.safeParse(body);
  if (!parsed.success || (Number.isFinite(declared) && declared > MAX_BODY_BYTES)) {
    throw new DomainError('VALIDATION_ERROR');
  }
  return parsed.data;
}

const answer = (result: TokenResult) => ({
  pseudonym: result.pseudonym,
  expires_at: result.expiresAt.toISOString(),
  reused: result.reused,
});

const actorOf = (who: Authenticated) => ({
  requestingService: who.requestingService,
  ...(who.actor === undefined ? {} : { actorId: who.actor.actorId, actorRole: who.actor.role }),
});

/** The wire form of a page: snake_case, ISO instants, and only the fields a row has (PRD 10). */
const pageBody = (page: AuditPage) => ({
  items: page.items.map((row) => ({
    id: row.id,
    created_at: row.createdAt.toISOString(),
    action: row.action,
    status: row.status,
    reason: row.reason,
    requesting_service: row.requestingService,
    ...(row.actorId === null ? {} : { actor_id: row.actorId }),
    ...(row.pseudonym === null ? {} : { pseudonym: row.pseudonym }),
    ...(row.purpose === null ? {} : { purpose: row.purpose }),
    ...(row.transactionId === null ? {} : { transaction_id: row.transactionId }),
    ...(row.mappingId === null ? {} : { mapping_id: row.mappingId }),
    ...(row.disclosureId === null ? {} : { disclosure_id: row.disclosureId }),
    ...(row.attributeNames === null ? {} : { attribute_names: row.attributeNames }),
  })),
  next_cursor: page.nextCursor,
});

const limitOf = (value: string | undefined): { limit?: number } =>
  value === undefined ? {} : { limit: Number(value) };

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
    const input = shape(pseudonymize, headers, body);
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

  /** ADR-0019: `{requests}` in, `{items}` out in the same order. Caller and service come from the token (D-16). */
  async pseudonymizeBatch(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(pseudonymizeBatch, headers, body);
    const results = await this.run(() =>
      this.deps.tokens.generateBatch(
        input.requests.map((element) => ({
          requestingService: who.requestingService,
          ...(who.actor === undefined ? {} : { actorId: who.actor.actorId }),
          subjectType: element.subject_type,
          subjectId: element.subject_id,
          targetService: element.target_service,
          purpose: element.purpose,
          ...(element.transaction_id === undefined
            ? {}
            : { transactionId: element.transaction_id }),
        })),
      ),
    );
    return { items: results.map(answer) };
  }

  async reIssue(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(reIssue, headers, body);
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

  async resolveDomain(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(resolveDomain, headers, body);
    const result = await this.run(() =>
      this.deps.tokens.resolveDomain({
        requestingService: who.requestingService,
        ...(who.actor === undefined ? {} : { actorId: who.actor.actorId }),
        notifToken: input.notif_token,
      }),
    );
    return { notification_domain_id: result.notificationDomainId };
  }

  /** Spec privacy 4.5. The pseudonym is the path; the body must be empty. Caller and role come from the token (ADR-0007). */
  async revokeToken(headers: AuthHeaders, pseudonym: string, body: unknown) {
    const who = await this.caller(headers);
    shape(noBody, headers, body ?? {});
    const result = await this.run(() =>
      this.deps.revocation.revokeToken({ ...actorOf(who), pseudonym }),
    );
    return {
      pseudonym: result.pseudonym,
      status: 'revoked',
      revoked_at: result.revokedAt.toISOString(),
    };
  }

  /** Spec privacy 4.6. */
  async revokeSubject(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(revokeSubject, headers, body);
    const result = await this.run(() =>
      this.deps.revocation.revokeSubject({
        ...actorOf(who),
        subjectType: input.subject_type,
        subjectId: input.subject_id,
      }),
    );
    return { revoked_count: result.revokedCount };
  }

  /** Spec privacy 4.8. The identity of the reader is the verified token; nothing in the query names it. */
  async auditLog(headers: AuthHeaders, query: unknown) {
    const who = await this.caller(headers);
    const input = shape(auditList, headers, query);
    const page = await this.run(() =>
      this.deps.auditLog.list(actorOf(who), {
        ...limitOf(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.service === undefined ? {} : { service: input.service }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.pseudonym === undefined ? {} : { pseudonym: input.pseudonym }),
        ...(input.transaction_id === undefined ? {} : { transactionId: input.transaction_id }),
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.disclosure_id === undefined ? {} : { disclosureId: input.disclosure_id }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
      }),
    );
    return pageBody(page);
  }

  async auditTimeline(headers: AuthHeaders, pseudonym: string, query: unknown) {
    const who = await this.caller(headers);
    const input = shape(auditTimeline, headers, query);
    const page = await this.run(() =>
      this.deps.auditLog.timeline(actorOf(who), pseudonym, {
        ...limitOf(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    );
    return pageBody(page);
  }

  async auditSummary(headers: AuthHeaders, query: unknown) {
    const who = await this.caller(headers);
    const input = shape(auditSummary, headers, query);
    const result = await this.run(() =>
      this.deps.auditLog.summary(actorOf(who), {
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
      }),
    );
    return {
      total: result.total,
      denied: result.denied,
      alerts: result.alerts.map((alert) => ({
        requesting_service: alert.requestingService,
        reason: alert.reason,
        count: alert.count,
        window_start: alert.windowStart.toISOString(),
      })),
    };
  }

  /** Spec privacy 4.10: 201 `{disclosure_id, status: PENDING}`. The requester is the person of the token. */
  async requestDisclosure(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(disclosureRequest, headers, body);
    const result = await this.run(() =>
      this.deps.disclosure.request({
        ...actorOf(who),
        auditToken: input.audit_token,
        basis: input.basis,
        caseRef: input.case_ref,
        attributes: input.attributes,
      }),
    );
    return { disclosure_id: result.disclosureId, status: result.status };
  }

  async approveDisclosure(headers: AuthHeaders, disclosureId: string, body: unknown) {
    const who = await this.caller(headers);
    shape(noBody, headers, body ?? {});
    const result = await this.run(() =>
      this.deps.disclosure.approve({ ...actorOf(who), disclosureId }),
    );
    return {
      disclosure_id: result.disclosureId,
      status: result.status,
      expires_at: result.expiresAt.toISOString(),
    };
  }

  async rejectDisclosure(headers: AuthHeaders, disclosureId: string, body: unknown) {
    const who = await this.caller(headers);
    shape(noBody, headers, body ?? {});
    const result = await this.run(() =>
      this.deps.disclosure.reject({ ...actorOf(who), disclosureId }),
    );
    return { disclosure_id: result.disclosureId, status: result.status };
  }

  /** Spec privacy 4.3: only the attributes that were approved; no subject at the top level, no phone, no account. */
  async dePseudonymize(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(dePseudonymize, headers, body);
    const result = await this.run(() =>
      this.deps.opening.open({
        ...actorOf(who),
        pseudonym: input.pseudonym,
        purpose: input.purpose,
        disclosureId: input.disclosure_id,
      }),
    );
    return { mapping_id: result.mappingId, attributes: result.attributes };
  }

  async transactionStatus(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(transactionStatus, headers, body);
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

  /** Spec privacy 4.9: 201 for the first call of a customer, 200 for a repeat; the values are never echoed. */
  async storeIdentity(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    const input = shape(storeIdentity, headers, body);
    const result = await this.run(() =>
      this.deps.vault.store({
        requestingService: who.requestingService,
        customerId: input.customer_id,
        nik: input.nik,
        nama: input.nama,
        hp: input.hp,
        rekening: input.rekening,
      }),
    );
    return {
      created: result.created,
      body: { customer_id: input.customer_id, stored: [...result.storedAttributes] },
    };
  }
}
