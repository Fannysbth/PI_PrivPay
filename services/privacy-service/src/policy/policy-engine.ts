import { DomainError } from '@privpay/common';
import type { AuditAttributeName } from '../audit';
import {
  DISCLOSURE_BASES,
  DISCLOSABLE_ATTRIBUTES,
  PURPOSES,
  TABLE_1,
  TABLE_2,
  TABLE_3,
  type ContextId,
  type ContextOperation,
  type ContextRow,
  type Operation,
  type PolicyPurpose,
} from './tables';

export type { ContextId, ContextOperation, Operation, PolicyPurpose } from './tables';

export type PurposeTtl = Readonly<Record<PolicyPurpose, number>>;

/** The combination a stored mapping or a request names. Plain strings: whatever arrives is checked against Tabel 1. */
export interface ContextKey {
  readonly serviceId: string;
  readonly purpose: string;
  readonly subjectType: string;
}

export interface PolicyContext extends ContextRow {
  readonly ttlSeconds: number;
}

export interface EvaluateRequest {
  readonly operation: ContextOperation;
  /** From the `azp` claim of the service token, never from a body (invariant 7). */
  readonly requestingService: string;
  readonly context: ContextKey;
  /** From the actor token; only P7 looks at it. */
  readonly actorRole?: string;
}

const deny = (): DomainError => new DomainError('POLICY_NOT_ALLOWED');

/** Tabel 5 for every context that may not be opened. */
const NONE: readonly AuditAttributeName[] = Object.freeze([]);

/**
 * Policy of Tabel 1, 2, 3, 5 and 6 (spec privacy 6). Pure: no I/O, no clock, no randomness. Failures are
 * `POLICY_NOT_ALLOWED`, or `FORBIDDEN_ROLE` when only the role is missing; the caller and the way of issue are always
 * checked before the role.
 */
export class PolicyEngine {
  private readonly table: readonly PolicyContext[];

  /** TTL per purpose in seconds, from configuration (PRD 17); a missing or non-positive value stops the start. */
  constructor(ttlSeconds: PurposeTtl) {
    for (const purpose of PURPOSES) {
      const ttl: unknown = ttlSeconds[purpose];
      if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0) {
        throw new RangeError(`TTL of ${purpose} must be a positive whole number of seconds`);
      }
    }
    this.table = Object.freeze(
      TABLE_1.map((row) => Object.freeze({ ...row, ttlSeconds: ttlSeconds[row.purpose] })),
    );
  }

  contexts(): readonly PolicyContext[] {
    return this.table;
  }

  /** The context of a stored mapping (PRD 6.2 `contextOf`), or nothing for a combination outside Tabel 1. */
  contextOf(key: ContextKey): PolicyContext | undefined {
    return this.table.find(
      (row) =>
        row.serviceId === key.serviceId &&
        row.purpose === key.purpose &&
        row.subjectType === key.subjectType,
    );
  }

  /** Tabel 3, the caller alone: all that RESOLVE_NOTIF_DOMAIN checks before it reads the token (PRD 7.3 STEP 0). */
  authorizeCaller(operation: Operation, requestingService: string): void {
    this.ruleOf(operation, requestingService);
  }

  /**
   * Tabel 3 caller and way of issue, then the Tabel 1 row, then the role. Spec 6 lists the Tabel 1 row first; the
   * caller is looked at first here because the rule is found by it, and the order cannot be seen from outside (every
   * failure before the role is POLICY_NOT_ALLOWED). Only the operations that touch a context (not EXCHANGE or
   * RESOLVE_NOTIF_DOMAIN) are accepted by the type: those use `exchangeTarget` and `authorizeCaller`.
   */
  evaluate(request: EvaluateRequest): PolicyContext {
    const rule = this.ruleOf(request.operation, request.requestingService);
    const context = this.contextOf(request.context);
    if (context === undefined || !rule.contexts.includes(context.id)) throw deny();
    if (context.requiredRole === 'auditor' && request.actorRole !== 'auditor') {
      throw new DomainError('FORBIDDEN_ROLE');
    }
    return context;
  }

  /**
   * Tabel 2 before the token is read (PRD 7.2 STEP 0): the caller and the wanted target must belong to one of the
   * two exchanges.
   */
  exchangeTarget(
    requestingService: string,
    target: { readonly serviceId: string; readonly purpose: string },
  ): PolicyContext {
    this.authorizeCaller('EXCHANGE', requestingService);
    const found = TABLE_2.find((exchange) => {
      const wanted = this.byId(exchange.target);
      return (
        exchange.caller === requestingService &&
        wanted.serviceId === target.serviceId &&
        wanted.purpose === target.purpose
      );
    });
    if (found === undefined) throw deny();
    return this.byId(found.target);
  }

  /**
   * Tabel 2 after ownership is proved (PRD 7.2 STEP 2): is this exact source to target exchange one of the two? The
   * caller builds `target` from the source mapping's `subject_type` (PRD 7.2 STEP 3), so a target of another subject
   * type is not a context of Tabel 1 and is refused here.
   */
  exchangeAllowed(source: ContextKey, target: ContextKey, requestingService: string): boolean {
    const from = this.contextOf(source);
    const to = this.contextOf(target);
    if (from === undefined || to === undefined) return false;
    return TABLE_2.some(
      (exchange) =>
        exchange.caller === requestingService &&
        exchange.source === from.id &&
        exchange.target === to.id,
    );
  }

  /** Tabel 5: the attributes a disclosure may return for this context; none unless it may be opened. */
  attributesFor(key: ContextKey): readonly AuditAttributeName[] {
    return this.contextOf(key)?.mayDisclose === true ? DISCLOSABLE_ATTRIBUTES : NONE;
  }

  /**
   * Tabel 6 (PRD 7.4 flow E2, TK-27): only these bases may open a disclosure request. The caller records a refusal
   * as INVALID_BASIS, audited (spec privacy 9.4).
   */
  isValidBasis(basis: string): boolean {
    return DISCLOSURE_BASES.includes(basis);
  }

  private ruleOf(operation: Operation, requestingService: string): (typeof TABLE_3)[number] {
    const rule = TABLE_3.find((entry) => entry.operation === operation);
    if (rule === undefined || rule.caller !== requestingService) throw deny();
    return rule;
  }

  private byId(id: ContextId): PolicyContext {
    const found = this.table.find((row) => row.id === id);
    if (found === undefined) throw new Error('Tabel 1 has no such context');
    return found;
  }
}
