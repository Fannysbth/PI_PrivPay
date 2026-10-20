import { randomUUID } from 'node:crypto';
import { DomainError, type Clock } from '@privpay/common';
import type { AuditedOperation, OperationTx } from '../audit';
import { mappingBinding, type BlindIndex, type FieldCipher, type TokenMint } from '../crypto';
import type { PolicyEngine } from '../policy';
import { effectiveStatus, type StoredStatus } from './status';
import { baseOf, decide, denied, resultOf, successEntry } from './token-audit';
import type {
  ExchangeRequest,
  FromTransactionRequest,
  GenerateRequest,
  Issued,
  TokenResult,
} from './token-types';
import { assertExchange, assertFromTransaction, assertGenerate } from './token-validation';

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
  // Exchange STEP 1 (PRD 7.2): the token the caller presents, found by its value (UNIQUE on pseudonym). FOR SHARE keeps
  // a revocation or a retention purge from committing between the checks of STEP 1 and the insert of STEP 3: it waits
  // for this transaction, or has already committed and is seen here.
  findSource: `SELECT id, subject_type, subject_id_enc, service_id, purpose, status, expires_at, purged_at
     FROM pseudonym_mapping WHERE pseudonym = $1 FOR SHARE`,
  // Form 3 STEP 1 (PRD 6.1 generate_from_transaction): the P1/P2 row of the transaction, expired ones included
  // (idx_mapping_tx). Only a row of the service and purpose that Gateway issues from: a token of another service that
  // carries the same transaction id is never a source (invariant 5).
  findByTransaction: `SELECT id, subject_type, subject_id_enc, purged_at FROM pseudonym_mapping
     WHERE transaction_id = $1 AND subject_type = $2 AND service_id = $3 AND purpose = $4
     ORDER BY created_at DESC LIMIT 1 FOR SHARE`,
} as const;

/** Spec privacy 7.2 step 6: the limit chosen by the spec (K-12). */
const MAX_PSEUDONYM_ATTEMPTS = 20;

/** The context the Gateway issues P1 and P2 for, the only source of form 3 (PRD Tabel 1). */
const SOURCE_SERVICE = 'TRANSACTION';
const SOURCE_PURPOSE = 'PAYMENT_PROCESSING';

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

      // STEP 2: the exact source context, now that the token is proved to be the caller's. PRD 7.2 also names
      // policy_evaluate here; with the target built from the source's subject type, exchangeAllowed and the target of
      // STEP 0 (whose TTL is used) decide the same thing, so it is not asked twice.
      const subjectType = { subjectType: source.subject_type };
      const allowed = this.deps.policy.exchangeAllowed(
        { serviceId: source.service_id, purpose: source.purpose, ...subjectType },
        { serviceId: request.targetService, purpose: request.purpose, ...subjectType },
        request.requestingService,
      );
      if (!allowed) throw denied(base, 'POLICY_NOT_ALLOWED', named);

      // STEP 3: the subject is decrypted inside and never leaves.
      const issued = await this.issueFromSource(tx, source, source.subject_id_enc, {
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

      // STEP 2 (the subject is decrypted inside and never leaves) and STEP 3 (buat_token), PRD 6.1.
      const issued = await this.issueFromSource(tx, source, source.subject_id_enc, {
        targetService: request.targetService,
        purpose: request.purpose,
        transactionId: request.transactionId,
        ttlSeconds: context.ttlSeconds,
      });
      return { result: resultOf(issued), audit: successEntry(base, issued) };
    });
  }

  /** Exchange and form 3 issue from the subject of a stored row: decrypt it with the binding of that row, then buat_token. */
  private async issueFromSource(
    tx: OperationTx,
    source: { id: string; subject_type: string },
    encrypted: Buffer,
    target: {
      targetService: string;
      purpose: string;
      transactionId: string;
      ttlSeconds: number;
    },
  ): Promise<Issued> {
    const subjectId = this.deps.cipher.decrypt(
      encrypted,
      mappingBinding(source.subject_type, source.id),
    );
    return this.issue(tx, { subjectType: source.subject_type, subjectId, ...target });
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
