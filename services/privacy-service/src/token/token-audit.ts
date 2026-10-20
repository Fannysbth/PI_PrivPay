import { DomainError, type Reason } from '@privpay/common';
import { DeniedOperation, type AuditAction, type AuditEntry, type SuccessEntry } from '../audit';
import type { CommonRequest, Issued, TokenResult } from './token-types';

// The audit rows of TokenService (spec privacy 9.4): what a refusal and a success say, and which refusals are decisions.

/** The fields of an audit row that do not depend on the outcome. */
export interface AuditBase {
  readonly action: Extract<AuditAction, 'GENERATE_TOKEN' | 'EXCHANGE_TOKEN' | 'RE_ISSUE'>;
  readonly requestingService: string;
  /** Known from the request, or, for re-issue, from the token once it has been read. */
  readonly purpose?: string;
  readonly transactionId?: string;
  readonly actorId?: string;
}

export function baseOf(
  action: AuditBase['action'],
  request: CommonRequest & { purpose?: string; transactionId?: string },
): AuditBase {
  return {
    action,
    requestingService: request.requestingService,
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    ...(request.transactionId === undefined ? {} : { transactionId: request.transactionId }),
    ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
  };
}

/** A refusal that is a decision, audited as DENIED (spec privacy 9.4). `mapping` and `pseudonym` name what was presented. */
export function denied(
  base: AuditBase,
  reason: Reason,
  presented: { pseudonym?: string; mappingId?: string } = {},
): DeniedOperation {
  const entry: AuditEntry = { ...base, status: 'DENIED', reason, ...presented };
  return new DeniedOperation(entry);
}

/**
 * The policy answers with POLICY_NOT_ALLOWED or FORBIDDEN_ROLE: those two are decisions and are audited; any other
 * failure is not a decision and propagates as it is.
 */
export function decide<T>(base: AuditBase, presented: { pseudonym?: string }, ask: () => T): T {
  try {
    return ask();
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.reason === 'POLICY_NOT_ALLOWED' || error.reason === 'FORBIDDEN_ROLE')
    ) {
      throw denied(base, error.reason, presented);
    }
    throw error;
  }
}

export function successEntry(base: AuditBase, issued: Issued): SuccessEntry {
  return {
    ...base,
    status: 'SUCCESS',
    reason: issued.reused ? 'REUSED_ACTIVE' : 'OK',
    pseudonym: issued.pseudonym,
    mappingId: issued.mappingId,
    keyVersion: issued.keyVersion,
  };
}

export const resultOf = ({ pseudonym, expiresAt, reused }: Issued): TokenResult => ({
  pseudonym,
  expiresAt,
  reused,
});
