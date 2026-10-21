import { DomainError, type Clock, type Reason } from '@privpay/common';
import {
  AUDIT_FORMATS,
  DeniedOperation,
  type AuditAttributeName,
  type AuditedOperation,
  type PersonCaller,
  type SuccessEntry,
} from '../audit';
import type { FieldCipher } from '../crypto';
import { vaultBinding } from '../crypto';
import type { PolicyEngine } from '../policy';
import { effectiveStatus, type StoredStatus } from '../token';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Spec privacy 4.3, Tabel 3: the only caller, and the role of the person it acts for (Tabel 1, ADR-0007). */
const ROLE = 'auditor';

/**
 * Every value is a bind parameter (CLAUDE.md). Only the three columns of Tabel 5 are selected from the vault: the phone
 * and the account number are never read here, so they cannot be decrypted by mistake (spec privacy 7.8).
 */
export const DE_PSEUDONYMIZE_SQL = {
  // FOR SHARE: a revocation or a purge of the token cannot commit between the checks and the use (as in request).
  findToken: `SELECT id, service_id, purpose, subject_type, status, expires_at, purged_at, subject_lookup, key_version
     FROM pseudonym_mapping WHERE pseudonym = $1 FOR SHARE`,
  // Spec privacy 7.8: the request must belong to this token. The row is locked, so two uses at once are taken one after
  // the other and the second sees USED.
  findRequest: `SELECT id, status, expires_at, requester_id, requested_attrs
     FROM disclosure_request WHERE id = $1 AND mapping_id = $2 FOR UPDATE`,
  findVault: `SELECT id, customer_id_enc, nik_enc, nama_enc FROM identity_vault
     WHERE customer_lookup = $1 AND purged_at IS NULL FOR SHARE`,
  // The one-time marker: the state is checked again by the update itself, so a second use cannot slip past the lock.
  use: `UPDATE disclosure_request SET status = 'USED', used_at = $2 WHERE id = $1 AND status = 'APPROVED'`,
} as const;

export interface DePseudonymizeRequest extends PersonCaller {
  readonly pseudonym: string;
  readonly purpose: string;
  readonly disclosureId: string;
}
export interface DePseudonymizeResult {
  readonly mappingId: string;
  readonly attributes: Readonly<Partial<Record<AuditAttributeName, string>>>;
}

export interface DePseudonymizeServiceDeps {
  readonly operation: AuditedOperation;
  readonly policy: Pick<PolicyEngine, 'authorizeCaller' | 'attributesFor'>;
  readonly cipher: Pick<FieldCipher, 'decrypt'>;
  readonly clock: Clock;
  /** GRACE_PERIOD_SECONDS (spec 7.1), for the status of the token. */
  readonly graceSeconds: number;
}

interface TokenRow {
  id: string;
  service_id: string;
  purpose: string;
  subject_type: string;
  status: StoredStatus;
  expires_at: Date;
  purged_at: Date | null;
  subject_lookup: string | null;
  key_version: number;
}
interface RequestRow {
  id: string;
  status: string;
  expires_at: Date | null;
  requester_id: string;
  requested_attrs: AuditAttributeName[];
}
interface VaultRow {
  id: string;
  customer_id_enc: Buffer;
  nik_enc: Buffer;
  nama_enc: Buffer;
}

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');
const matches = (value: unknown, pattern: RegExp): void => {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
};

/**
 * `de_pseudonymize` (spec privacy 4.3, 7.8, PRD 7.4, FR-09): the only way an identity leaves Privacy, and only the
 * attributes a second person approved, once, within the approval window. Every refusal that depends on who asks, the
 * token or the request is a decision and leaves one DENIED row; the shape of the request is a 422 that touches
 * nothing. Neither the rows nor the errors carry a value: the audit row names the attributes.
 */
export class DePseudonymizeService {
  constructor(private readonly deps: DePseudonymizeServiceDeps) {}

  async open(input: DePseudonymizeRequest): Promise<DePseudonymizeResult> {
    matches(input.requestingService, SERVICE_ID);
    if (input.actorId !== undefined) matches(input.actorId, AUDIT_FORMATS.actorId);
    matches(input.pseudonym, AUDIT_FORMATS.pseudonym);
    matches(input.purpose, AUDIT_FORMATS.purpose);
    matches(input.disclosureId, UUID);
    const base = {
      action: 'DE_PSEUDONYMIZE',
      requestingService: input.requestingService,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    } as const;
    const refuse = (
      reason: Reason,
      named: {
        pseudonym?: string;
        purpose?: string;
        mappingId?: string;
        disclosureId?: string;
      } = {},
    ) => new DeniedOperation({ ...base, status: 'DENIED', reason, ...named });

    return this.deps.operation.run<DePseudonymizeResult>(async (tx) => {
      // STEP 0 (AZ-22): the caller, then the role, before any row is read, so a caller that may not ask learns nothing.
      // The role comes before gate 5 because that gate names the requester, who is always an auditor: after it, an
      // admin could never be answered FORBIDDEN_ROLE (TK-08). Recorded as N-29.
      try {
        this.deps.policy.authorizeCaller('DE_PSEUDONYMIZE', input.requestingService);
      } catch (error) {
        if (error instanceof DomainError) throw refuse(error.reason);
        throw error;
      }
      if (input.actorId === undefined || input.actorRole !== ROLE) throw refuse('FORBIDDEN_ROLE');

      // GATES 1 to 4: the token exists, is the caller's, for this purpose, and is alive now.
      const found = await tx.query<TokenRow>(DE_PSEUDONYMIZE_SQL.findToken, [input.pseudonym]);
      const token = found.rows[0];
      const named = { pseudonym: input.pseudonym };
      if (token === undefined) throw refuse('TOKEN_NOT_FOUND', named);
      const known = { ...named, mappingId: token.id };
      if (token.service_id !== input.requestingService) throw refuse('SERVICE_MISMATCH', known);
      if (token.purpose !== input.purpose) throw refuse('PURPOSE_MISMATCH', known);
      const status = effectiveStatus(
        { status: token.status, expiresAt: token.expires_at },
        this.deps.clock.now(),
        this.deps.graceSeconds,
      );
      if (status === 'revoked') throw refuse('REVOKED', known);
      if (status === 'expired') throw refuse('EXPIRED', known);
      // The identity was emptied by retention: nothing is left to open (K-13).
      if (token.purged_at !== null || token.subject_lookup === null) {
        throw refuse('TOKEN_NOT_FOUND', known);
      }

      // GATE 5: the request is this token's, approved, within its window, and the asker's own.
      const requests = await tx.query<RequestRow>(DE_PSEUDONYMIZE_SQL.findRequest, [
        input.disclosureId,
        token.id,
      ]);
      const request = requests.rows[0];
      if (request === undefined) throw refuse('DISCLOSURE_NOT_FOUND', known);
      const withRequest = { ...known, disclosureId: request.id };
      if (request.status !== 'APPROVED') throw refuse('DISCLOSURE_NOT_APPROVED', withRequest);
      if (request.expires_at === null || this.deps.clock.now() > request.expires_at) {
        throw refuse('DISCLOSURE_EXPIRED', withRequest);
      }
      if (request.requester_id !== input.actorId) throw refuse('REQUESTER_MISMATCH', withRequest);

      // Tabel 1 "boleh dibuka": only P7, and only the attributes of Tabel 5 among those that were approved.
      const allowed = this.deps.policy.attributesFor({
        serviceId: token.service_id,
        purpose: token.purpose,
        subjectType: token.subject_type,
      });
      if (allowed.length === 0) throw refuse('POLICY_NOT_ALLOWED', withRequest);
      const wanted = request.requested_attrs.filter((name) => allowed.includes(name));

      const vault = (
        await tx.query<VaultRow>(DE_PSEUDONYMIZE_SQL.findVault, [token.subject_lookup])
      ).rows[0];
      // K-13: the mapping exists but its vault row is gone or emptied.
      if (vault === undefined) throw refuse('TOKEN_NOT_FOUND', withRequest);

      const marked = await tx.query(DE_PSEUDONYMIZE_SQL.use, [request.id, this.deps.clock.now()]);
      if (marked.rowCount !== 1) throw refuse('DISCLOSURE_NOT_APPROVED', withRequest);

      const columns = {
        customer_id: vault.customer_id_enc,
        nik: vault.nik_enc,
        nama: vault.nama_enc,
      };
      const attributes: Partial<Record<AuditAttributeName, string>> = {};
      for (const name of wanted) {
        attributes[name] = this.deps.cipher.decrypt(columns[name], vaultBinding(name, vault.id));
      }
      const audit: SuccessEntry = {
        ...base,
        status: 'SUCCESS',
        reason: 'OK',
        pseudonym: input.pseudonym,
        purpose: token.purpose,
        mappingId: token.id,
        disclosureId: request.id,
        attributeNames: wanted,
        keyVersion: token.key_version,
      };
      return { result: { mappingId: token.id, attributes }, audit };
    });
  }
}
