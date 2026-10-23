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
import type { ReconciliationService } from './reconciliation';

const SERVICE = 'reconciliation-service';
/** Spec reconciliation 3: only the Gateway calls (AZ-34, AZ-35), the bank and the other services never do. */
const CALLER = 'API_GATEWAY';

// The token of an audit exists only where Privacy does (proposed); the reference to an account is the mode's (N-44).
const AUDIT_TOKEN = /^PSEU-[0-9A-F]{8}$/;
const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BANK_REFERENCE = /^[A-Z0-9-]{1,32}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** N-27: the most a report may carry, and the byte limit of its route (gateway-tokenizer.md 3, K-12). */
export const MAX_SETTLEMENT_ITEMS = 500;
export const MAX_SETTLEMENT_BYTES = 64 * 1024;

const isRealDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};
const isoDate = z.string().regex(ISO_DATE).refine(isRealDate);

// The report arrives tokenised (FR-32): an account number, or a field of any other name, is refused. Two lines with the
// same bank reference are refused here, since the database would refuse them as a server error (K-05).
const settlementReport = (account: RegExp) =>
  z.strictObject({
    batch_date: isoDate,
    items: z
      .array(
        z.strictObject({
          account_pseudonym: z.string().regex(account),
          amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          bank_reference: z.string().regex(BANK_REFERENCE),
        }),
      )
      .min(1)
      .max(MAX_SETTLEMENT_ITEMS)
      .refine((items) => new Set(items.map((item) => item.bank_reference)).size === items.length),
  });
const runBody = z.strictObject({ date: isoDate });
// Spec reconciliation 3.3: a coded reason, never free text; the customer is not named, the transaction is.
const auditBody = z.strictObject({
  transaction_id: z.string().regex(TRANSACTION_ID),
  reason_code: z.enum(['AMOUNT_MISMATCH', 'DISPUTE', 'OTHER']),
});
// Spec reconciliation 3.4: the token and the approved request, nothing about what to open or why.
const disclosureBody = z.strictObject({
  audit_token: z.string().regex(AUDIT_TOKEN),
  disclosure_id: z.string().regex(UUID),
});

export interface ReconciliationHttpDeps {
  readonly clock: Clock;
  readonly issuer: string;
  readonly keys: JwksKeys;
  readonly reconciliation: Pick<
    ReconciliationService,
    'receiveReport' | 'run' | 'auditRequest' | 'disclose'
  >;
  /** The form of the reference to an account in this mode (N-44). */
  readonly accountRef: RegExp;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/**
 * What the controller does, without the framework: prove the caller (and the person behind it), check the shape, hand
 * the work to the service. `requesting_service` comes from the verified token only (invariant 7). No answer, error or
 * log carries an account number or an identity: this service never has one.
 */
export class ReconciliationHttp {
  private readonly reportSchema: ReturnType<typeof settlementReport>;

  constructor(private readonly deps: ReconciliationHttpDeps) {
    this.reportSchema = settlementReport(deps.accountRef);
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

  private async gateway(headers: AuthHeaders): Promise<Authenticated> {
    const who = await this.caller(headers);
    if (who.requestingService !== CALLER) throw new DomainError('POLICY_NOT_ALLOWED');
    return who;
  }

  /** Spec reconciliation 3.1 (AZ-34). The caller is decided before the body is read, so another service learns nothing. */
  async settlementReport(headers: AuthHeaders, body: unknown) {
    await this.gateway(headers);
    // Declared length first, as at the Gateway; the parsed size too, for a body that did not declare one.
    const declared = Number(single(headers['content-length']) ?? 0);
    if (
      (Number.isFinite(declared) && declared > MAX_SETTLEMENT_BYTES) ||
      Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_SETTLEMENT_BYTES
    ) {
      throw new DomainError('VALIDATION_ERROR');
    }
    const parsed = this.reportSchema.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const result = await this.deps.reconciliation.receiveReport({
      batchDate: parsed.data.batch_date,
      items: parsed.data.items.map((item) => ({
        accountPseudonym: item.account_pseudonym,
        amount: item.amount,
        bankReference: item.bank_reference,
      })),
    });
    return {
      created: result.created,
      body: { batch_date: result.batchDate, item_count: result.itemCount },
    };
  }

  /** Spec reconciliation 3.2 (AZ-08, AZ-35): the Gateway on behalf of an `admin`, read from the verified actor token. */
  async run(headers: AuthHeaders, body: unknown) {
    const who = await this.gateway(headers);
    if (who.actor?.role !== 'admin') throw new DomainError('FORBIDDEN_ROLE');
    const parsed = runBody.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    return this.deps.reconciliation.run(parsed.data.date);
  }

  /** The Gateway for an `auditor`: the id of the person and their token, both read from the verified actor token. */
  private async auditor(headers: AuthHeaders): Promise<{ actorId: string; token: string }> {
    const who = await this.gateway(headers);
    const token = single(headers['x-actor-token']);
    if (who.actor?.role !== 'auditor' || token === undefined)
      throw new DomainError('FORBIDDEN_ROLE');
    return { actorId: who.actor.actorId, token };
  }

  /** Spec reconciliation 3.3 (AZ-06, AZ-36). */
  async auditRequest(headers: AuthHeaders, body: unknown) {
    const actor = await this.auditor(headers);
    const parsed = auditBody.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    return this.deps.reconciliation.auditRequest(
      { transactionId: parsed.data.transaction_id, reasonCode: parsed.data.reason_code },
      actor,
    );
  }

  /** Spec reconciliation 3.4 (AZ-07, AZ-37, K-15). */
  async disclosure(headers: AuthHeaders, body: unknown) {
    const actor = await this.auditor(headers);
    const parsed = disclosureBody.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    return this.deps.reconciliation.disclose(
      { auditToken: parsed.data.audit_token, disclosureId: parsed.data.disclosure_id },
      actor,
    );
  }
}
