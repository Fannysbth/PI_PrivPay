import { randomUUID } from 'node:crypto';
import { DomainError, type Clock } from '@privpay/common';
import { AUDIT_FORMATS, DeniedOperation, type AuditedOperation, type OperationTx } from '../audit';
import { mappingBinding, type BlindIndex, type FieldCipher, type TokenMint } from '../crypto';
import type { PolicyEngine } from '../policy';

/**
 * The statements of buat_token, exported so the tests can ask PostgreSQL for their plans (NFR-04). Every value is a
 * bind parameter (CLAUDE.md).
 */
export const TOKEN_SQL = {
  // Spec privacy 7.2 step 2: the lock that keeps parallel requests for one combination in line (ADR-0010). A row that
  // does not exist yet cannot be locked with FOR UPDATE, so the lock is on the key of the combination.
  lock: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  // Step 3: without this, an INSERT after the TTL breaks uq_mapping_active (T-06, FR-33).
  expireStale: `UPDATE pseudonym_mapping SET status = 'expired'
     WHERE subject_lookup = $1 AND service_id = $2 AND purpose = $3 AND status = 'active' AND expires_at < $4`,
  findActive: `SELECT id, pseudonym, expires_at, key_version FROM pseudonym_mapping
     WHERE subject_lookup = $1 AND service_id = $2 AND purpose = $3 AND status = 'active'`,
  // Step 6: a taken pseudonym value is not an error, it is retried from a new nonce (ADR-0010, E-19).
  insert: `INSERT INTO pseudonym_mapping
       (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, transaction_id,
        key_version, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (pseudonym) DO NOTHING RETURNING id`,
} as const;

/** Spec privacy 7.2 step 6: the limit chosen by the spec (K-12). */
const MAX_PSEUDONYM_ATTEMPTS = 20;

// Formats of platform-dan-ci.md 3.1; the shape of a request is checked before anything is decided or audited.
const CUSTOMER_ID = /^CUST-[0-9]{6}$/;
const ACCOUNT_NUMBER = /^[0-9]{8,20}$/;
const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;

export interface GenerateRequest {
  /** From the `azp` claim of the service token, never from a body (invariant 7). */
  readonly requestingService: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly transactionId?: string;
  readonly actorId?: string;
}

export interface TokenResult {
  readonly pseudonym: string;
  readonly expiresAt: Date;
  readonly reused: boolean;
}

export interface TokenServiceDeps {
  readonly operation: AuditedOperation;
  readonly policy: Pick<PolicyEngine, 'evaluate'>;
  readonly index: Pick<BlindIndex, 'lookup'>;
  readonly cipher: Pick<FieldCipher, 'encrypt'>;
  readonly mint: Pick<TokenMint, 'mint'>;
  readonly clock: Clock;
  /** The `key_version` of new rows (PSEUDONYM_KEY_VERSION). */
  readonly keyVersion: number;
  /** UUID v4 for row ids and nonces; replaceable so a collision can be forced in a test. */
  readonly newId?: () => string;
}

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');
const isText = (value: unknown): value is string => typeof value === 'string';

/** The text fields are checked as text first: the type says string, but the data comes from outside (CLAUDE.md). */
function assertShape(request: GenerateRequest): void {
  const {
    requestingService,
    subjectType,
    subjectId,
    targetService,
    purpose,
    transactionId,
    actorId,
  } = request;
  if (!isText(requestingService) || !SERVICE_ID.test(requestingService)) throw invalid();
  if (subjectType !== 'CUSTOMER' && subjectType !== 'ACCOUNT') throw invalid();
  const idPattern = subjectType === 'CUSTOMER' ? CUSTOMER_ID : ACCOUNT_NUMBER;
  if (!isText(subjectId) || !idPattern.test(subjectId)) throw invalid();
  if (!isText(targetService) || !SERVICE_ID.test(targetService)) throw invalid();
  if (!isText(purpose) || !AUDIT_FORMATS.purpose.test(purpose)) throw invalid();
  if (
    transactionId !== undefined &&
    (!isText(transactionId) || !AUDIT_FORMATS.transactionId.test(transactionId))
  ) {
    throw invalid();
  }
  if (actorId !== undefined && (!isText(actorId) || !AUDIT_FORMATS.actorId.test(actorId)))
    throw invalid();
}

interface ActiveRow {
  id: string;
  pseudonym: string;
  expires_at: Date;
  key_version: number;
}

/**
 * Issues tokens (spec privacy 7.2, 7.3). One operation, one transaction: the policy decision, the lock, the marking of
 * expired rows, the reuse or the insert, and the audit row all commit together or not at all. The subject id is only
 * ever used to compute the lookup and the token and to be encrypted; it is not logged and not audited.
 */
export class TokenService {
  private readonly newId: () => string;

  constructor(private readonly deps: TokenServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  /** `POST /pseudonymize` form 1 (from identity; the Gateway only, Tabel 3). */
  async generate(request: GenerateRequest): Promise<TokenResult> {
    assertShape(request);
    const { requestingService, subjectType, subjectId, targetService, purpose } = request;
    const audited = {
      action: 'GENERATE_TOKEN',
      requestingService,
      purpose,
      ...(request.transactionId === undefined ? {} : { transactionId: request.transactionId }),
      ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
    } as const;

    return this.deps.operation.run<TokenResult>(async (tx) => {
      // Spec 7.3 STEP 0. A refusal is a decision and is audited (spec 9.4): the type of the error says so.
      let ttlSeconds: number;
      try {
        ttlSeconds = this.deps.policy.evaluate({
          operation: 'GENERATE_FROM_IDENTITY',
          requestingService,
          context: { serviceId: targetService, purpose, subjectType },
        }).ttlSeconds;
      } catch (error) {
        // Only the two answers of the policy are decisions; any other failure is not, and is not audited as one.
        if (
          error instanceof DomainError &&
          (error.reason === 'POLICY_NOT_ALLOWED' || error.reason === 'FORBIDDEN_ROLE')
        ) {
          throw new DeniedOperation({ ...audited, status: 'DENIED', reason: error.reason });
        }
        throw error;
      }

      const lookup = this.deps.index.lookup(subjectType, subjectId);
      await tx.query(TOKEN_SQL.lock, [`${lookup.toString('hex')}|${targetService}|${purpose}`]);
      // Read after the lock (spec 7.2 steps 3 and 7): a request that waited judges the token by the time it got in.
      const now = this.deps.clock.now();
      await tx.query(TOKEN_SQL.expireStale, [lookup, targetService, purpose, now]);

      const found = await tx.query<ActiveRow>(TOKEN_SQL.findActive, [
        lookup,
        targetService,
        purpose,
      ]);
      const active = found.rows[0];
      if (active !== undefined) {
        return {
          result: { pseudonym: active.pseudonym, expiresAt: active.expires_at, reused: true },
          audit: {
            ...audited,
            status: 'SUCCESS',
            reason: 'REUSED_ACTIVE',
            pseudonym: active.pseudonym,
            mappingId: active.id,
            keyVersion: active.key_version,
          },
        };
      }

      const issued = await this.insert(tx, {
        request,
        lookup,
        now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      });
      return {
        result: { pseudonym: issued.pseudonym, expiresAt: issued.expiresAt, reused: false },
        audit: {
          ...audited,
          status: 'SUCCESS',
          reason: 'OK',
          pseudonym: issued.pseudonym,
          mappingId: issued.id,
          keyVersion: this.deps.keyVersion,
        },
      };
    });
  }

  /** Spec 7.2 steps 5 to 7: encrypt, then try pseudonym values until one is free. */
  private async insert(
    tx: OperationTx,
    input: { request: GenerateRequest; lookup: Buffer; now: Date; expiresAt: Date },
  ): Promise<{ id: string; pseudonym: string; expiresAt: Date }> {
    const { request, lookup, now, expiresAt } = input;
    const id = this.newId();
    const encrypted = this.deps.cipher.encrypt(
      request.subjectId,
      mappingBinding(request.subjectType, id),
    );
    for (let attempt = 1; attempt <= MAX_PSEUDONYM_ATTEMPTS; attempt += 1) {
      const pseudonym = this.deps.mint.mint({
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        serviceId: request.targetService,
        purpose: request.purpose,
        nonce: this.newId(),
      });
      const result = await tx.query(TOKEN_SQL.insert, [
        id,
        request.subjectType,
        encrypted,
        lookup,
        pseudonym,
        request.targetService,
        request.purpose,
        request.transactionId ?? null,
        this.deps.keyVersion,
        now,
        expiresAt,
      ]);
      if (result.rowCount === 1) return { id, pseudonym, expiresAt };
    }
    // Logged with the request id by the HTTP layer; nothing of the subject goes into the error.
    throw new DomainError('INTERNAL_ERROR', 'pseudonym_collision');
  }
}
