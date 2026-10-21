import { DomainError } from '@privpay/common';
import { AUDIT_FORMATS } from './audit-entry';
import {
  DeniedOperation,
  type AuditedOperation,
  type AuditedResult,
  type SuccessEntry,
} from './audited-operation';
import type {
  AuditListFilter,
  AuditPage,
  AuditPaging,
  AuditRange,
  AuditReader,
  AuditSummary,
} from './audit-reader';

/** Spec privacy 4.8 and ADR-0007: the admin console, acting as a person of the listed role. */
const CALLER = 'ADMIN_CONSOLE';
const LIST_ROLES = ['auditor', 'admin'] as const;
const AUDITOR_ONLY = ['auditor'] as const;

const FILTER = /^[A-Za-z0-9_.:-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;

export interface AuditCaller {
  readonly requestingService: string;
  readonly actorId?: string | undefined;
  /** From the verified token, never from a request (invariant 7). */
  readonly actorRole?: string | undefined;
}

export interface AuditLogServiceDeps {
  /** Writes the VIEW_AUDIT_LOG row through the pool of privpay_app. */
  readonly operation: AuditedOperation;
  /** Reads through the pool of privpay_auditor. */
  readonly reader: AuditReader;
}

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');

function matching(value: string | undefined, pattern: RegExp): void {
  if (value !== undefined && (typeof value !== 'string' || !pattern.test(value))) throw invalid();
}
function instant(value: Date | undefined): void {
  if (value !== undefined && !(value instanceof Date && !Number.isNaN(value.getTime()))) {
    throw invalid();
  }
}

/**
 * Reading the audit log (spec privacy 4.8, FR-14, US-13). Whoever reads leaves one VIEW_AUDIT_LOG row, SUCCESS for a
 * read and DENIED for a refusal (K-27), written in the transaction of the operation: a read is never without a trace.
 * The caller and the role are decided before the log is touched, and a request whose shape is wrong is a 422 that
 * reads and writes nothing (spec privacy 9.4).
 */
export class AuditLogService {
  constructor(private readonly deps: AuditLogServiceDeps) {}

  /** `GET /audit-log`: an auditor or an admin. */
  async list(caller: AuditCaller, filter: AuditListFilter): Promise<AuditPage> {
    matching(filter.service, SERVICE_ID);
    matching(filter.status, FILTER);
    matching(filter.reason, FILTER);
    matching(filter.action, FILTER);
    matching(filter.pseudonym, AUDIT_FORMATS.pseudonym);
    matching(filter.transactionId, AUDIT_FORMATS.transactionId);
    matching(filter.disclosureId, UUID);
    instant(filter.from);
    instant(filter.to);
    return await this.read(
      caller,
      LIST_ROLES,
      {
        ...(filter.pseudonym === undefined ? {} : { pseudonym: filter.pseudonym }),
        ...(filter.transactionId === undefined ? {} : { transactionId: filter.transactionId }),
      },
      () => this.deps.reader.list(filter),
    );
  }

  /** `GET /audit-log/timeline/{pseudonym}`: an auditor. */
  async timeline(caller: AuditCaller, pseudonym: string, paging: AuditPaging): Promise<AuditPage> {
    matching(pseudonym, AUDIT_FORMATS.pseudonym);
    return await this.read(caller, AUDITOR_ONLY, { pseudonym }, () =>
      this.deps.reader.timeline(pseudonym, paging),
    );
  }

  /** `GET /audit-log/summary`: an auditor. */
  async summary(caller: AuditCaller, range: AuditRange): Promise<AuditSummary> {
    instant(range.from);
    instant(range.to);
    return await this.read(caller, AUDITOR_ONLY, {}, () => this.deps.reader.summary(range));
  }

  private read<T>(
    caller: AuditCaller,
    roles: readonly string[],
    named: { pseudonym?: string; transactionId?: string },
    work: () => Promise<T>,
  ): Promise<T> {
    matching(caller.requestingService, SERVICE_ID);
    matching(caller.actorId, AUDIT_FORMATS.actorId);
    const base = {
      action: 'VIEW_AUDIT_LOG',
      requestingService: caller.requestingService,
      ...(caller.actorId === undefined ? {} : { actorId: caller.actorId }),
    } as const;
    return this.deps.operation.run<T>(async (): Promise<AuditedResult<T>> => {
      if (caller.requestingService !== CALLER) {
        throw new DeniedOperation({ ...base, status: 'DENIED', reason: 'POLICY_NOT_ALLOWED' });
      }
      if (caller.actorRole === undefined || !roles.includes(caller.actorRole)) {
        throw new DeniedOperation({ ...base, status: 'DENIED', reason: 'FORBIDDEN_ROLE' });
      }
      // Read first, so the row of this very read is not in its own answer; the row commits with the operation.
      const result = await work();
      const audit: SuccessEntry = { ...base, status: 'SUCCESS', reason: 'OK', ...named };
      return { result, audit };
    });
  }
}
