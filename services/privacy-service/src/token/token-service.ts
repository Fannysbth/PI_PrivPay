import { randomUUID } from 'node:crypto';
import { DomainError, type Clock, type Reason } from '@privpay/common';
import {
  AUDIT_FORMATS,
  DeniedOperation,
  type AuditAction,
  type AuditEntry,
  type AuditedOperation,
  type OperationTx,
  type SuccessEntry,
} from '../audit';
import { mappingBinding, type BlindIndex, type FieldCipher, type TokenMint } from '../crypto';
import type { PolicyEngine } from '../policy';
import { effectiveStatus, type StoredStatus } from './status';

/**
 * The statements of buat_token and of the two forms that read a source row, exported so the tests can ask PostgreSQL
 * for their plans (NFR-04). Every value is a bind parameter (CLAUDE.md).
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
  // Exchange STEP 1 (PRD 7.2): the token the caller presents, found by its value (UNIQUE on pseudonym).
  findSource: `SELECT id, subject_type, subject_id_enc, service_id, purpose, status, expires_at, purged_at
     FROM pseudonym_mapping WHERE pseudonym = $1`,
  // Form 3 STEP 1 (PRD 6.1 generate_from_transaction): the P1/P2 row of the transaction, expired ones included
  // (idx_mapping_tx). Only a row of the service and purpose that Gateway issues from: a token of another service that
  // carries the same transaction id is never a source (invariant 5).
  findByTransaction: `SELECT id, subject_type, subject_id_enc, purged_at FROM pseudonym_mapping
     WHERE transaction_id = $1 AND subject_type = $2 AND service_id = $3 AND purpose = $4
     ORDER BY created_at DESC LIMIT 1`,
} as const;

/** Spec privacy 7.2 step 6: the limit chosen by the spec (K-12). */
const MAX_PSEUDONYM_ATTEMPTS = 20;

/** The context the Gateway issues P1 and P2 for, the only source of form 3 (PRD Tabel 1). */
const SOURCE_SERVICE = 'TRANSACTION';
const SOURCE_PURPOSE = 'PAYMENT_PROCESSING';

// Formats of platform-dan-ci.md 3.1; the shape of a request is checked before anything is decided or audited.
const CUSTOMER_ID = /^CUST-[0-9]{6}$/;
const ACCOUNT_NUMBER = /^[0-9]{8,20}$/;
const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;

/** What every form carries. `requestingService` is from the `azp` claim of the service token, never from a body (invariant 7). */
interface CommonRequest {
  readonly requestingService: string;
  readonly actorId?: string;
}

/** Form 1: from identity (the Gateway only). */
export interface GenerateRequest extends CommonRequest {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly transactionId?: string;
}

/** Form 2: the caller trades a token of its own for one of another service (TRANSACTION only; Tabel 2). */
export interface ExchangeRequest extends CommonRequest {
  readonly sourcePseudonym: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly transactionId: string;
}

/** Form 3: Reconciliation asks for P6 or P7 by transaction id; for P7 the actor must be an auditor. */
export interface FromTransactionRequest extends CommonRequest {
  readonly transactionId: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly subjectType: string;
  /** From the actor token (`X-Actor-Token`); only P7 looks at it. */
  readonly actorRole?: string;
}

export interface TokenResult {
  readonly pseudonym: string;
  readonly expiresAt: Date;
  readonly reused: boolean;
}

export interface TokenServiceDeps {
  readonly operation: AuditedOperation;
  readonly policy: Pick<PolicyEngine, 'evaluate' | 'exchangeTarget' | 'exchangeAllowed'>;
  readonly index: Pick<BlindIndex, 'lookup'>;
  readonly cipher: Pick<FieldCipher, 'encrypt' | 'decrypt'>;
  readonly mint: Pick<TokenMint, 'mint'>;
  readonly clock: Clock;
  /** GRACE_PERIOD_SECONDS: the window in which a token past its TTL still accepts an operation under way (spec 7.1). */
  readonly graceSeconds: number;
  /** The `key_version` of new rows (PSEUDONYM_KEY_VERSION). */
  readonly keyVersion: number;
  /** UUID v4 for row ids and nonces; replaceable so a collision can be forced in a test. */
  readonly newId?: () => string;
}

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');
const isText = (value: unknown): value is string => typeof value === 'string';

function textMatching(value: unknown, pattern: RegExp): void {
  if (!isText(value) || !pattern.test(value)) throw invalid();
}

/** The text fields are checked as text first: the type says string, but the data comes from outside (CLAUDE.md). */
function assertCommon(request: CommonRequest): void {
  textMatching(request.requestingService, SERVICE_ID);
  if (request.actorId !== undefined) textMatching(request.actorId, AUDIT_FORMATS.actorId);
}

function assertTarget(request: { targetService: string; purpose: string }): void {
  textMatching(request.targetService, SERVICE_ID);
  textMatching(request.purpose, AUDIT_FORMATS.purpose);
}

function assertSubjectType(subjectType: unknown): 'CUSTOMER' | 'ACCOUNT' {
  if (subjectType !== 'CUSTOMER' && subjectType !== 'ACCOUNT') throw invalid();
  return subjectType;
}

function assertGenerate(request: GenerateRequest): void {
  assertCommon(request);
  assertTarget(request);
  const subjectType = assertSubjectType(request.subjectType);
  textMatching(request.subjectId, subjectType === 'CUSTOMER' ? CUSTOMER_ID : ACCOUNT_NUMBER);
  if (request.transactionId !== undefined) {
    textMatching(request.transactionId, AUDIT_FORMATS.transactionId);
  }
}

function assertExchange(request: ExchangeRequest): void {
  assertCommon(request);
  assertTarget(request);
  textMatching(request.sourcePseudonym, AUDIT_FORMATS.pseudonym);
  textMatching(request.transactionId, AUDIT_FORMATS.transactionId);
}

function assertFromTransaction(request: FromTransactionRequest): void {
  assertCommon(request);
  assertTarget(request);
  assertSubjectType(request.subjectType);
  textMatching(request.transactionId, AUDIT_FORMATS.transactionId);
  if (request.actorRole !== undefined && !isText(request.actorRole)) throw invalid();
}

interface ActiveRow {
  id: string;
  pseudonym: string;
  expires_at: Date;
  key_version: number;
}

interface SourceRow {
  id: string;
  subject_type: string;
  subject_id_enc: Buffer | null;
  service_id: string;
  purpose: string;
  status: StoredStatus;
  expires_at: Date;
  purged_at: Date | null;
}

interface TransactionSourceRow {
  id: string;
  subject_type: string;
  subject_id_enc: Buffer | null;
  purged_at: Date | null;
}

/** What `issue` made or found, in the terms the audit row and the result need. */
interface Issued extends TokenResult {
  readonly mappingId: string;
  readonly keyVersion: number;
}

/** The fields of an audit row that do not depend on the outcome. */
interface AuditBase {
  readonly action: Extract<AuditAction, 'GENERATE_TOKEN' | 'EXCHANGE_TOKEN'>;
  readonly requestingService: string;
  readonly purpose: string;
  readonly transactionId?: string;
  readonly actorId?: string;
}

function baseOf(
  action: AuditBase['action'],
  request: CommonRequest & { purpose: string; transactionId?: string },
): AuditBase {
  return {
    action,
    requestingService: request.requestingService,
    purpose: request.purpose,
    ...(request.transactionId === undefined ? {} : { transactionId: request.transactionId }),
    ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
  };
}

/** A refusal that is a decision, audited as DENIED (spec privacy 9.4). `mapping` and `pseudonym` name what was presented. */
function denied(
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
function decide<T>(base: AuditBase, presented: { pseudonym?: string }, ask: () => T): T {
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

function successEntry(base: AuditBase, issued: Issued): SuccessEntry {
  return {
    ...base,
    status: 'SUCCESS',
    reason: issued.reused ? 'REUSED_ACTIVE' : 'OK',
    pseudonym: issued.pseudonym,
    mappingId: issued.mappingId,
    keyVersion: issued.keyVersion,
  };
}

const resultOf = ({ pseudonym, expiresAt, reused }: Issued): TokenResult => ({
  pseudonym,
  expiresAt,
  reused,
});

/**
 * Issues tokens in the three forms of POST /pseudonymize (spec privacy 4.1, 7.2 to 7.5). One operation, one
 * transaction: the policy decision, the reading of a source, the lock, the marking of expired rows, the reuse or the
 * insert, and the audit row all commit together or not at all. The subject id is only ever used to compute the
 * lookup and the token and to be encrypted; it is not logged and not audited, and no result carries it.
 *
 * The audit row of a success names the token that was issued or given back; the row of a refusal names the token that
 * was presented, when there is one (exchange).
 */
export class TokenService {
  private readonly newId: () => string;

  constructor(private readonly deps: TokenServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  /** Form 1, from identity (the Gateway only, Tabel 3): spec 7.3. */
  async generate(request: GenerateRequest): Promise<TokenResult> {
    assertGenerate(request);
    const base = baseOf('GENERATE_TOKEN', request);
    return this.deps.operation.run<TokenResult>(async (tx) => {
      // Spec 7.3 STEP 0. A refusal is a decision and is audited (spec 9.4): the type of the error says so.
      const context = decide(base, {}, () =>
        this.deps.policy.evaluate({
          operation: 'GENERATE_FROM_IDENTITY',
          requestingService: request.requestingService,
          context: {
            serviceId: request.targetService,
            purpose: request.purpose,
            subjectType: request.subjectType,
          },
        }),
      );
      const issued = await this.issue(tx, {
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        targetService: request.targetService,
        purpose: request.purpose,
        transactionId: request.transactionId,
        ttlSeconds: context.ttlSeconds,
      });
      return { result: resultOf(issued), audit: successEntry(base, issued) };
    });
  }

  /** Form 2, exchange (TRANSACTION only; Tabel 2): spec 7.5, PRD 7.2. */
  async exchange(request: ExchangeRequest): Promise<TokenResult> {
    assertExchange(request);
    const base = baseOf('EXCHANGE_TOKEN', request);
    const presented = { pseudonym: request.sourcePseudonym };
    return this.deps.operation.run<TokenResult>(async (tx) => {
      // STEP 0: the pair (caller, target) of Tabel 2, before any token is read.
      const target = decide(base, presented, () =>
        this.deps.policy.exchangeTarget(request.requestingService, {
          serviceId: request.targetService,
          purpose: request.purpose,
        }),
      );

      // STEP 1: the token exists, is the caller's, and is usable.
      const found = await tx.query<SourceRow>(TOKEN_SQL.findSource, [request.sourcePseudonym]);
      const source = found.rows[0];
      if (source === undefined) throw denied(base, 'TOKEN_NOT_FOUND', presented);
      const named = { ...presented, mappingId: source.id };
      if (source.service_id !== request.requestingService) {
        throw denied(base, 'SERVICE_MISMATCH', named);
      }
      const status = effectiveStatus(
        { status: source.status, expiresAt: source.expires_at },
        this.deps.clock.now(),
        this.deps.graceSeconds,
      );
      if (status === 'revoked') throw denied(base, 'REVOKED', named);
      if (status === 'expired') throw denied(base, 'EXPIRED', named);
      // Retention empties the identity of an old row; there is nothing left to exchange from.
      if (source.subject_id_enc === null || source.purged_at !== null) {
        throw denied(base, 'TOKEN_NOT_FOUND', named);
      }

      // STEP 2: the exact source context, now that the token is proved to be the caller's.
      const subjectType = { subjectType: source.subject_type };
      const allowed = this.deps.policy.exchangeAllowed(
        { serviceId: source.service_id, purpose: source.purpose, ...subjectType },
        { serviceId: request.targetService, purpose: request.purpose, ...subjectType },
        request.requestingService,
      );
      if (!allowed) throw denied(base, 'POLICY_NOT_ALLOWED', named);

      // STEP 3: the subject is decrypted here and never leaves.
      const subjectId = this.deps.cipher.decrypt(
        source.subject_id_enc,
        mappingBinding(source.subject_type, source.id),
      );
      const issued = await this.issue(tx, {
        subjectType: source.subject_type,
        subjectId,
        targetService: request.targetService,
        purpose: request.purpose,
        transactionId: request.transactionId,
        ttlSeconds: target.ttlSeconds,
      });
      return { result: resultOf(issued), audit: successEntry(base, issued) };
    });
  }

  /** Form 3, P6 and P7 from a transaction id (Reconciliation only; Tabel 3): spec 7.4, PRD 6.1. */
  async generateFromTransaction(request: FromTransactionRequest): Promise<TokenResult> {
    assertFromTransaction(request);
    const base = baseOf('GENERATE_TOKEN', request);
    return this.deps.operation.run<TokenResult>(async (tx) => {
      // STEP 0, including the auditor role for P7 (FORBIDDEN_ROLE).
      const context = decide(base, {}, () =>
        this.deps.policy.evaluate({
          operation: 'GENERATE_FROM_TRANSACTION',
          requestingService: request.requestingService,
          context: {
            serviceId: request.targetService,
            purpose: request.purpose,
            subjectType: request.subjectType,
          },
          actorRole: request.actorRole,
        }),
      );

      // STEP 1: the P1/P2 row of the transaction, expired ones included; one emptied by retention is gone.
      const found = await tx.query<TransactionSourceRow>(TOKEN_SQL.findByTransaction, [
        request.transactionId,
        request.subjectType,
        SOURCE_SERVICE,
        SOURCE_PURPOSE,
      ]);
      const source = found.rows[0];
      if (source === undefined) throw denied(base, 'TOKEN_NOT_FOUND');
      if (source.subject_id_enc === null || source.purged_at !== null) {
        throw denied(base, 'TOKEN_NOT_FOUND', { mappingId: source.id });
      }

      // STEP 2 and 3: the subject is decrypted here and never leaves.
      const subjectId = this.deps.cipher.decrypt(
        source.subject_id_enc,
        mappingBinding(source.subject_type, source.id),
      );
      const issued = await this.issue(tx, {
        subjectType: source.subject_type,
        subjectId,
        targetService: request.targetService,
        purpose: request.purpose,
        transactionId: request.transactionId,
        ttlSeconds: context.ttlSeconds,
      });
      return { result: resultOf(issued), audit: successEntry(base, issued) };
    });
  }

  /**
   * buat_token (spec privacy 7.2): the part all three forms share. The lock comes first; the clock is read once it is
   * held, so a request that waited judges the token by the time it got in.
   */
  private async issue(
    tx: OperationTx,
    input: {
      subjectType: string;
      subjectId: string;
      targetService: string;
      purpose: string;
      transactionId: string | undefined;
      ttlSeconds: number;
    },
  ): Promise<Issued> {
    const { subjectType, subjectId, targetService, purpose } = input;
    const lookup = this.deps.index.lookup(subjectType, subjectId);
    await tx.query(TOKEN_SQL.lock, [`${lookup.toString('hex')}|${targetService}|${purpose}`]);
    const now = this.deps.clock.now();
    await tx.query(TOKEN_SQL.expireStale, [lookup, targetService, purpose, now]);

    const found = await tx.query<ActiveRow>(TOKEN_SQL.findActive, [lookup, targetService, purpose]);
    const active = found.rows[0];
    if (active !== undefined) {
      return {
        pseudonym: active.pseudonym,
        expiresAt: active.expires_at,
        reused: true,
        mappingId: active.id,
        keyVersion: active.key_version,
      };
    }

    // Spec 7.2 steps 5 to 7: encrypt, then try pseudonym values until one is free.
    const id = this.newId();
    const encrypted = this.deps.cipher.encrypt(subjectId, mappingBinding(subjectType, id));
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    for (let attempt = 1; attempt <= MAX_PSEUDONYM_ATTEMPTS; attempt += 1) {
      const pseudonym = this.deps.mint.mint({
        subjectType,
        subjectId,
        serviceId: targetService,
        purpose,
        nonce: this.newId(),
      });
      const result = await tx.query(TOKEN_SQL.insert, [
        id,
        subjectType,
        encrypted,
        lookup,
        pseudonym,
        targetService,
        purpose,
        input.transactionId ?? null,
        this.deps.keyVersion,
        now,
        expiresAt,
      ]);
      if (result.rowCount === 1) {
        return {
          pseudonym,
          expiresAt,
          reused: false,
          mappingId: id,
          keyVersion: this.deps.keyVersion,
        };
      }
    }
    // Logged with the request id by the HTTP layer; nothing of the subject goes into the error.
    throw new DomainError('INTERNAL_ERROR', 'pseudonym_collision');
  }
}
