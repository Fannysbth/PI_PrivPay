import { randomUUID } from 'node:crypto';
import { DomainError, type Clock, type Reason } from '@privpay/common';
import {
  AUDIT_FORMATS,
  DeniedOperation,
  refuseUnlessPerson,
  type AuditAction,
  type AuditAttributeName,
  type AuditedOperation,
  type PersonCaller,
  type SuccessEntry,
} from '../audit';
import type { PolicyEngine } from '../policy';
import { effectiveStatus, type StoredStatus } from '../token';

const CASE_REF = /^[A-Z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;

/** The token a request names must be the one Reconciliation holds for an audit (P7, Tabel 1). */
const P7 = {
  serviceId: 'RECONCILIATION',
  purpose: 'INTERNAL_AUDIT',
  subjectType: 'CUSTOMER',
} as const;

/** Every value is a bind parameter (CLAUDE.md). */
export const DISCLOSURE_SQL = {
  // FOR SHARE: a revocation or a purge cannot commit between the checks and the insert (as in exchange).
  findToken: `SELECT id, service_id, purpose, subject_type, status, expires_at, purged_at, key_version
     FROM pseudonym_mapping WHERE pseudonym = $1 FOR SHARE`,
  insert: `INSERT INTO disclosure_request
       (id, mapping_id, basis, case_ref, requested_attrs, requester_id, status, created_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6, 'PENDING', $7)`,
  // Spec privacy 4.10, 7.9: the request is locked, so two deciders at once are taken one after the other and the second
  // sees the first's decision. The pseudonym is read only to name it in the audit row.
  find: `SELECT d.id, d.mapping_id, d.requester_id, d.status, d.requested_attrs, m.pseudonym, m.purpose, m.key_version
     FROM disclosure_request d JOIN pseudonym_mapping m ON m.id = d.mapping_id
     WHERE d.id = $1 FOR UPDATE OF d`,
  approve: `UPDATE disclosure_request SET status = 'APPROVED', approver_id = $2, decided_at = $3, expires_at = $4
     WHERE id = $1`,
  reject: `UPDATE disclosure_request SET status = 'REJECTED', decided_at = $2 WHERE id = $1`,
} as const;

export interface RequestDisclosure extends PersonCaller {
  readonly auditToken: string;
  readonly basis: string;
  readonly caseRef: string;
  readonly attributes: readonly string[];
}
export interface DecideDisclosure extends PersonCaller {
  readonly disclosureId: string;
}
export interface RequestedDisclosure {
  readonly disclosureId: string;
  readonly status: 'PENDING';
}
export interface ApprovedDisclosure {
  readonly disclosureId: string;
  readonly status: 'APPROVED';
  readonly expiresAt: Date;
}
export interface RejectedDisclosure {
  readonly disclosureId: string;
  readonly status: 'REJECTED';
}

export interface DisclosureServiceDeps {
  readonly operation: AuditedOperation;
  readonly policy: Pick<PolicyEngine, 'isValidBasis' | 'attributesFor'>;
  readonly clock: Clock;
  /** GRACE_PERIOD_SECONDS (spec 7.1), for the status of the token a request names. */
  readonly graceSeconds: number;
  /** DISCLOSURE_APPROVAL_TTL_SECONDS: how long an approval can be used (PRD 17, 600). */
  readonly approvalTtlSeconds: number;
  /** UUID v4 for the request; replaceable in a test. */
  readonly newId?: () => string;
}

interface TokenRow {
  id: string;
  service_id: string;
  purpose: string;
  subject_type: string;
  status: StoredStatus;
  expires_at: Date;
  purged_at: Date | null;
  key_version: number;
}
interface RequestRow {
  id: string;
  mapping_id: string;
  requester_id: string;
  status: string;
  requested_attrs: AuditAttributeName[];
  pseudonym: string;
  purpose: string;
  key_version: number;
}

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');
const matches = (value: unknown, pattern: RegExp): void => {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
};

/** The person is recorded as requester or approver; the console always names one, so a call without is malformed. */
function requirePerson(input: PersonCaller): void {
  if (input.actorId === undefined) throw invalid();
}

/**
 * The four-eyes flow that opens an identity (spec privacy 4.10, 7.9, 8, FR-09): an auditor asks, an admin who is not the
 * auditor decides, and an approval is good for a fixed time and one use (the use is M3-05). Every refusal that depends
 * on who asks, the state of the request, the token or the policy tables is a decision and leaves one DENIED row; a
 * request whose shape is wrong is a 422 that touches nothing (spec privacy 9.4). The audit rows name attributes, never
 * values, and the case reference is not audited at all.
 */
export class DisclosureService {
  private readonly newId: () => string;

  constructor(private readonly deps: DisclosureServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  /** `POST /disclosure-requests` (auditor). */
  async request(input: RequestDisclosure): Promise<RequestedDisclosure> {
    this.assertCaller(input);
    matches(input.auditToken, AUDIT_FORMATS.pseudonym);
    matches(input.caseRef, CASE_REF);
    matches(input.basis, /^.{1,64}$/);
    if (
      !Array.isArray(input.attributes) ||
      input.attributes.some((name) => typeof name !== 'string') ||
      new Set(input.attributes).size !== input.attributes.length
    ) {
      throw invalid();
    }
    const base = {
      action: 'DISCLOSURE_REQUESTED',
      requestingService: input.requestingService,
    } as const;
    const actor = input.actorId === undefined ? {} : { actorId: input.actorId };
    const refuse = (reason: Reason, named: { pseudonym?: string; mappingId?: string } = {}) =>
      new DeniedOperation({ ...base, ...actor, status: 'DENIED', reason, ...named });

    return this.deps.operation.run<RequestedDisclosure>(async (tx) => {
      refuseUnlessPerson('DISCLOSURE_REQUESTED', input, ['auditor']);
      requirePerson(input);
      // K-07, TK-27: the policy tables decide, not the syntax. A name outside the list is never stored, so the row
      // of the refusal names no attribute. When both are wrong the basis is what is reported.
      if (!this.deps.policy.isValidBasis(input.basis)) throw refuse('INVALID_BASIS');
      const allowed = this.deps.policy.attributesFor(P7);
      if (
        input.attributes.length === 0 ||
        !input.attributes.every((name) => allowed.some((ok) => ok === name))
      ) {
        throw refuse('ATTRIBUTE_NOT_ALLOWED');
      }
      const names = input.attributes as readonly AuditAttributeName[];

      const found = await tx.query<TokenRow>(DISCLOSURE_SQL.findToken, [input.auditToken]);
      const token = found.rows[0];
      const named = { pseudonym: input.auditToken };
      if (token === undefined) throw refuse('TOKEN_NOT_FOUND', named);
      const known = { ...named, mappingId: token.id };
      if (token.service_id !== P7.serviceId) throw refuse('SERVICE_MISMATCH', known);
      if (token.purpose !== P7.purpose) throw refuse('PURPOSE_MISMATCH', known);
      const status = effectiveStatus(
        { status: token.status, expiresAt: token.expires_at },
        this.deps.clock.now(),
        this.deps.graceSeconds,
      );
      if (status === 'revoked') throw refuse('REVOKED', known);
      if (status === 'expired') throw refuse('EXPIRED', known);
      if (token.purged_at !== null) throw refuse('TOKEN_NOT_FOUND', known);

      const id = this.newId();
      await tx.query(DISCLOSURE_SQL.insert, [
        id,
        token.id,
        input.basis,
        input.caseRef,
        [...names],
        input.actorId,
        this.deps.clock.now(),
      ]);
      const audit: SuccessEntry = {
        ...base,
        ...actor,
        status: 'SUCCESS',
        reason: 'OK',
        pseudonym: input.auditToken,
        purpose: token.purpose,
        mappingId: token.id,
        disclosureId: id,
        attributeNames: names,
        keyVersion: token.key_version,
      };
      return { result: { disclosureId: id, status: 'PENDING' }, audit };
    });
  }

  /** `POST /disclosure-requests/{id}/approve` (admin, not the requester). */
  async approve(input: DecideDisclosure): Promise<ApprovedDisclosure> {
    this.assertCaller(input);
    matches(input.disclosureId, UUID);
    return this.decide<ApprovedDisclosure>('DISCLOSURE_APPROVED', input, async (tx, row) => {
      // TK-24: the database says the same in chk_four_eyes; this answers it as a decision instead of an error.
      if (row.requester_id === input.actorId)
        throw this.denial('DISCLOSURE_APPROVED', input, 'SELF_APPROVAL', row);
      const decidedAt = this.deps.clock.now();
      const expiresAt = new Date(decidedAt.getTime() + this.deps.approvalTtlSeconds * 1000);
      await tx.query(DISCLOSURE_SQL.approve, [row.id, input.actorId, decidedAt, expiresAt]);
      return { disclosureId: row.id, status: 'APPROVED', expiresAt };
    });
  }

  /** `POST /disclosure-requests/{id}/reject` (admin). */
  async reject(input: DecideDisclosure): Promise<RejectedDisclosure> {
    this.assertCaller(input);
    matches(input.disclosureId, UUID);
    return this.decide<RejectedDisclosure>('DISCLOSURE_REJECTED', input, async (tx, row) => {
      await tx.query(DISCLOSURE_SQL.reject, [row.id, this.deps.clock.now()]);
      return { disclosureId: row.id, status: 'REJECTED' };
    });
  }

  /** Approve and reject share the gates: the caller, the role, the request exists, and it is still PENDING (K-01). */
  private decide<T>(
    action: Extract<AuditAction, 'DISCLOSURE_APPROVED' | 'DISCLOSURE_REJECTED'>,
    input: DecideDisclosure,
    change: (
      tx: Parameters<Parameters<AuditedOperation['run']>[0]>[0],
      row: RequestRow,
    ) => Promise<T>,
  ): Promise<T> {
    return this.deps.operation.run<T>(async (tx) => {
      refuseUnlessPerson(action, input, ['admin']);
      requirePerson(input);
      const found = await tx.query<RequestRow>(DISCLOSURE_SQL.find, [input.disclosureId]);
      const row = found.rows[0];
      if (row === undefined) throw this.denial(action, input, 'DISCLOSURE_NOT_FOUND');
      if (row.status !== 'PENDING') throw this.denial(action, input, 'DISCLOSURE_NOT_PENDING', row);
      const result = await change(tx, row);
      const audit: SuccessEntry = {
        action,
        requestingService: input.requestingService,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        status: 'SUCCESS',
        reason: 'OK',
        pseudonym: row.pseudonym,
        purpose: row.purpose,
        mappingId: row.mapping_id,
        disclosureId: row.id,
        attributeNames: row.requested_attrs,
        keyVersion: row.key_version,
      };
      return { result, audit };
    });
  }

  private denial(
    action: AuditAction,
    input: DecideDisclosure,
    reason: Reason,
    row?: RequestRow,
  ): DeniedOperation {
    return new DeniedOperation({
      action,
      requestingService: input.requestingService,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      status: 'DENIED',
      reason,
      ...(row === undefined
        ? {}
        : { pseudonym: row.pseudonym, mappingId: row.mapping_id, disclosureId: row.id }),
    });
  }

  private assertCaller(input: PersonCaller): void {
    matches(input.requestingService, SERVICE_ID);
    if (input.actorId !== undefined) matches(input.actorId, AUDIT_FORMATS.actorId);
  }
}
