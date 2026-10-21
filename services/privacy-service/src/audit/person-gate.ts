import { DeniedOperation } from './audited-operation';
import type { AuditAction } from './audit-entry';

/** Operations of people go through the admin console (ADR-0007): the caller is the console, the role is the person's. */
const CONSOLE = 'ADMIN_CONSOLE';

export interface PersonCaller {
  readonly requestingService: string;
  readonly actorId?: string | undefined;
  /** From the verified token, never from a request (invariant 7). */
  readonly actorRole?: string | undefined;
}

/**
 * Caller first, then role, both before any row is read, so a service that is not the console learns nothing about the
 * role it lacks. A refusal is a decision and leaves one DENIED row of `action` (K-27, spec privacy 9.4).
 */
export function refuseUnlessPerson(
  action: AuditAction,
  caller: PersonCaller,
  roles: readonly string[],
): void {
  const base = {
    action,
    requestingService: caller.requestingService,
    ...(caller.actorId === undefined ? {} : { actorId: caller.actorId }),
  } as const;
  if (caller.requestingService !== CONSOLE) {
    throw new DeniedOperation({ ...base, status: 'DENIED', reason: 'POLICY_NOT_ALLOWED' });
  }
  if (caller.actorRole === undefined || !roles.includes(caller.actorRole)) {
    throw new DeniedOperation({ ...base, status: 'DENIED', reason: 'FORBIDDEN_ROLE' });
  }
}
