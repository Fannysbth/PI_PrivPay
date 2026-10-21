import { DomainError, type Clock } from '@privpay/common';
import { AUDIT_FORMATS, DeniedOperation, type AuditedOperation, type SuccessEntry } from '../audit';
import type { BlindIndex } from '../crypto';
import type { IdentityVault } from '../identity';
import { ACCOUNT_NUMBER, CUSTOMER_ID, assertCommon, textMatching } from '../token/token-validation';

/** Every value is a bind parameter (CLAUDE.md). */
export const REVOCATION_SQL = {
  // Spec privacy 4.5: the row is locked so a parallel revocation or an exchange that holds it settles in order.
  findToken: `SELECT id, status, revoked_at, purpose, key_version FROM pseudonym_mapping
     WHERE pseudonym = $1 FOR UPDATE`,
  revokeToken: `UPDATE pseudonym_mapping SET status = 'revoked', revoked_at = $2 WHERE id = $1`,
  // PRD 6.2 revoke_subject STEP 2. The rows are locked in id order (as the retention job picks them), so two
  // revocations of one subject queue instead of waiting on each other; a row the job holds is waited for, not skipped
  // (K-33): a revocation must not leave an active token behind. Expired rows are left to retention (spec privacy 7.11).
  revokeSubject: `WITH picked AS (
       SELECT id FROM pseudonym_mapping
        WHERE subject_lookup = $1 AND status = 'active' ORDER BY id FOR UPDATE)
     UPDATE pseudonym_mapping m SET status = 'revoked', revoked_at = $2
       FROM picked WHERE m.id = picked.id
     RETURNING m.id, m.pseudonym, m.purpose, m.key_version`,
} as const;

/** Spec privacy 4.5, 4.6 and ADR-0007: the admin console, acting as a person of the role admin. */
const CALLER = 'ADMIN_CONSOLE';
const ROLE = 'admin';

interface Actor {
  readonly requestingService: string;
  readonly actorId?: string;
  /** From the verified token, never from a body (invariant 7). */
  readonly actorRole?: string;
}

export interface RevokeTokenRequest extends Actor {
  readonly pseudonym: string;
}
export interface RevokeTokenResult {
  readonly pseudonym: string;
  readonly revokedAt: Date;
}
export interface RevokeSubjectRequest extends Actor {
  readonly subjectType: string;
  readonly subjectId: string;
}
export interface RevokeSubjectResult {
  readonly revokedCount: number;
}

export interface RevocationServiceDeps {
  readonly operation: AuditedOperation;
  readonly index: Pick<BlindIndex, 'lookup'>;
  readonly vault: Pick<IdentityVault, 'purge'>;
  readonly clock: Clock;
}

interface TokenRow {
  id: string;
  status: string;
  revoked_at: Date | null;
  purpose: string;
  key_version: number;
}
interface RevokedRow {
  id: string;
  pseudonym: string;
  purpose: string;
  key_version: number;
}

interface Base {
  readonly action: 'REVOKE_TOKEN' | 'REVOKE_SUBJECT';
  readonly requestingService: string;
  readonly actorId?: string;
}

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');

const baseOf = (action: Base['action'], request: Actor): Base => ({
  action,
  requestingService: request.requestingService,
  ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
});

function assertActor(request: Actor): void {
  assertCommon(request);
  if (request.actorRole !== undefined && typeof request.actorRole !== 'string') throw invalid();
}

/** Caller first, then role: a service that is not the console learns nothing about the role it lacks (spec 9.4). */
function refuseUnlessAdmin(base: Base, request: Actor): void {
  if (request.requestingService !== CALLER) {
    throw new DeniedOperation({ ...base, status: 'DENIED', reason: 'POLICY_NOT_ALLOWED' });
  }
  if (request.actorRole !== ROLE) {
    throw new DeniedOperation({ ...base, status: 'DENIED', reason: 'FORBIDDEN_ROLE' });
  }
}

/**
 * Revocation by the admin console (spec privacy 4.5, 4.6, 7.10, FR-12, FR-29, FR-44). Nothing is deleted: a token is
 * marked revoked, and only the vault of a customer is emptied. The caller and the role are decided before any token is
 * read, so a refusal says nothing about which tokens exist.
 */
export class RevocationService {
  constructor(private readonly deps: RevocationServiceDeps) {}

  /** `POST /pseudonym/{pseudonym}/revoke`: an expired token can be revoked (K-11), a revoked one gives the same answer. */
  async revokeToken(request: RevokeTokenRequest): Promise<RevokeTokenResult> {
    assertActor(request);
    textMatching(request.pseudonym, AUDIT_FORMATS.pseudonym);
    const base = baseOf('REVOKE_TOKEN', request);
    return this.deps.operation.run<RevokeTokenResult>(async (tx) => {
      refuseUnlessAdmin(base, request);
      const found = await tx.query<TokenRow>(REVOCATION_SQL.findToken, [request.pseudonym]);
      const row = found.rows[0];
      if (row === undefined) {
        throw new DeniedOperation({
          ...base,
          status: 'DENIED',
          reason: 'TOKEN_NOT_FOUND',
          pseudonym: request.pseudonym,
        });
      }
      let revokedAt = row.revoked_at;
      if (row.status !== 'revoked' || revokedAt === null) {
        revokedAt = this.deps.clock.now();
        await tx.query(REVOCATION_SQL.revokeToken, [row.id, revokedAt]);
      }
      const audit: SuccessEntry = {
        ...base,
        status: 'SUCCESS',
        reason: 'OK',
        pseudonym: request.pseudonym,
        purpose: row.purpose,
        mappingId: row.id,
        keyVersion: row.key_version,
      };
      return { result: { pseudonym: request.pseudonym, revokedAt }, audit };
    });
  }

  /**
   * `POST /subject/revoke`: every active token of the subject, then the vault of a customer. Nothing to revoke and
   * nothing to empty is a refusal that is audited (one DENIED row) and still answers 200 with 0 (spec privacy 4.6).
   */
  async revokeSubject(request: RevokeSubjectRequest): Promise<RevokeSubjectResult> {
    assertActor(request);
    const customer = request.subjectType === 'CUSTOMER';
    if (!customer && request.subjectType !== 'ACCOUNT') throw invalid();
    textMatching(request.subjectId, customer ? CUSTOMER_ID : ACCOUNT_NUMBER);
    const base = baseOf('REVOKE_SUBJECT', request);
    const lookup = this.deps.index.lookup(request.subjectType, request.subjectId);
    try {
      return await this.deps.operation.run<RevokeSubjectResult>(async (tx) => {
        refuseUnlessAdmin(base, request);
        const revoked = await tx.query<RevokedRow>(REVOCATION_SQL.revokeSubject, [
          lookup,
          this.deps.clock.now(),
        ]);
        const purged = customer && (await this.deps.vault.purge(tx, lookup));
        const audit: SuccessEntry[] = revoked.rows.map((row) => ({
          ...base,
          status: 'SUCCESS',
          reason: 'OK',
          pseudonym: row.pseudonym,
          purpose: row.purpose,
          mappingId: row.id,
          keyVersion: row.key_version,
        }));
        // PRD 6.2 STEP 4: the audit row of the emptied vault names no value and no mapping.
        if (purged) {
          audit.push({ ...base, action: 'PURGE_IDENTITY', status: 'SUCCESS', reason: 'OK' });
        }
        const [first, ...rest] = audit;
        if (first === undefined) {
          throw new DeniedOperation({ ...base, status: 'DENIED', reason: 'TOKEN_NOT_FOUND' });
        }
        return { result: { revokedCount: revoked.rows.length }, audit: [first, ...rest] };
      });
    } catch (error) {
      // The refusal above is the audited "nothing there", not an error to the caller. Only that one: the policy
      // refusals are DeniedOperation too and must still reach the caller.
      if (
        error instanceof DeniedOperation &&
        error.entry.action === 'REVOKE_SUBJECT' &&
        error.entry.reason === 'TOKEN_NOT_FOUND'
      ) {
        return { revokedCount: 0 };
      }
      throw error;
    }
  }
}
