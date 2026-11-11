import { randomUUID } from 'node:crypto';
import { DomainError, type Clock } from '@privpay/common';
import type { AuditedOperation, OperationTx, SuccessEntry } from '../audit';
import { mappingBinding, type BlindIndex, type FieldCipher, type TokenMint } from '../crypto';
import type { PolicyEngine } from '../policy';
import { effectiveStatus, type StoredStatus } from './status';
import { TRANSACTION_STATUS_SQL, isTerminal } from './transaction-status';
import { baseOf, decide, denied, resultOf, successEntry, type AuditBase } from './token-audit';
import type {
  ExchangeRequest,
  FromTransactionRequest,
  GenerateRequest,
  Issued,
  ReIssueRequest,
  ResolveDomainRequest,
  ResolveDomainResult,
  TokenResult,
} from './token-types';
import {
  assertExchange,
  assertFromTransaction,
  assertGenerate,
  assertReIssue,
  assertResolveDomain,
} from './token-validation';

/**
 * The statements of buat_token and of the two forms that read a source row, exported so the tests can ask PostgreSQL
 * for their plans (NFR-04). Every value is a bind parameter (project rules).
 */
export const TOKEN_SQL = {
  // Spec privacy 7.2 step 2: the lock that keeps parallel requests for one combination in line (ADR-0010). A row that
  // does not exist yet cannot be locked with FOR UPDATE, so the lock is on the key of the combination.
  lock: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  // Steps 3 and 4 in one round trip (PERF-01, NFR-02). The UPDATE marks the rows past their TTL expired, which an INSERT
  // after the TTL needs to keep uq_mapping_active free (T-06, FR-33); the SELECT in the same statement reads the
  // snapshot from before that UPDATE, so it asks for `expires_at >= $4` itself and never returns a row the UPDATE has
  // just expired. The data-modifying CTE runs to completion even though nothing reads it.
  expireAndFindActive: `WITH expired AS (
       UPDATE pseudonym_mapping SET status = 'expired'
        WHERE subject_lookup = $1 AND service_id = $2 AND purpose = $3 AND status = 'active' AND expires_at < $4
       RETURNING id)
     SELECT id, pseudonym, expires_at, key_version FROM pseudonym_mapping
      WHERE subject_lookup = $1 AND service_id = $2 AND purpose = $3 AND status = 'active' AND expires_at >= $4`,
  // Step 6: a taken pseudonym value is not an error, it is retried from a new nonce (ADR-0010, E-19).
  insert: `INSERT INTO pseudonym_mapping
       (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, transaction_id,
        key_version, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (pseudonym) DO NOTHING RETURNING id`,
  // Exchange STEP 1 (PRD 7.2): the token the caller presents, found by its value (UNIQUE on pseudonym). FOR SHARE keeps
  // a revocation or a retention purge from committing between the checks of STEP 1 and the insert of STEP 3: it waits
  // for this transaction, or has already committed and is seen here.
  findSource: `SELECT id, subject_type, subject_id_enc, service_id, purpose, transaction_id, status, expires_at, purged_at
     FROM pseudonym_mapping WHERE pseudonym = $1 FOR SHARE`,
  // Re-issue STEP 1 (PRD 7.5): the same row, but FOR UPDATE, because this transaction goes on to update it (markExpired).
  // With FOR SHARE, two re-issues of one token would both hold the share lock and then both wait to update: a deadlock
  // (40P01). FOR UPDATE queues them instead, and the second finds the old token expired and the new one active.
  findSourceForUpdate: `SELECT id, subject_type, subject_id_enc, service_id, purpose, transaction_id, status, expires_at, purged_at
     FROM pseudonym_mapping WHERE pseudonym = $1 FOR UPDATE`,
  // Re-issue STEP 3 (PRD 7.5): the old token stops being the active one before buat_token looks for an active token.
  markExpired: `UPDATE pseudonym_mapping SET status = 'expired' WHERE id = $1 AND status = 'active'`,
  // Resolve-domain STEP 3 (PRD 7.3): the active P5 token of the subject of the presented row, matched on the blind index
  // already stored on that row, so the subject is not decrypted at all. FOR SHARE: a revocation of the P5 token cannot
  // commit between this read and the audit row.
  findDomain: `SELECT d.pseudonym, d.expires_at FROM pseudonym_mapping m
     JOIN pseudonym_mapping d ON d.subject_lookup = m.subject_lookup
     WHERE m.id = $1 AND d.service_id = $2 AND d.purpose = $3 AND d.status = 'active' FOR SHARE OF d`,
  // Form 3 STEP 1 (PRD 6.1 generate_from_transaction): the P1/P2 row of the transaction, expired ones included, found
  // through transaction_link (K-28, ADR-0013) because a reused token keeps only its first transaction id. Only the
  // context Gateway issues from: a token of another service that carries the same transaction id is never a source
  // (invariant 5).
  findByTransaction: `SELECT m.id, m.pseudonym, m.subject_type, m.subject_id_enc, m.purged_at, m.status, m.expires_at
     FROM transaction_link l JOIN pseudonym_mapping m ON m.pseudonym = l.pseudonym
     WHERE l.transaction_id = $1 AND l.subject_type = $2 AND l.service_id = $3 AND l.purpose = $4
     FOR SHARE OF m`,
  // K-28: the link is written whenever a token is issued or given back for a transaction id. DO NOTHING lets a
  // parallel request that wrote it first win; the reader below then tells a repeat from a conflict.
  insertLink: `INSERT INTO transaction_link (transaction_id, subject_type, service_id, purpose, pseudonym, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
  findLink: `SELECT pseudonym FROM transaction_link
     WHERE transaction_id = $1 AND subject_type = $2 AND service_id = $3 AND purpose = $4 FOR UPDATE`,
  // Re-issue only: the successor takes the place of the token it replaces, nothing else.
  moveLink: `UPDATE transaction_link SET pseudonym = $5
     WHERE transaction_id = $1 AND subject_type = $2 AND service_id = $3 AND purpose = $4 AND pseudonym = $6`,
} as const;

/** ADR-0019: a batch is the pair of one payment, P1 and P2. One place for the limit; the HTTP schema uses it too. */
export const MAX_BATCH = 2;

/** Spec privacy 7.2 step 6: the limit chosen by the spec (K-12). */
const MAX_PSEUDONYM_ATTEMPTS = 20;

/** PRD 7.3: the only token Notification may resolve (P4), and the one it gets back (P5). */
const NOTIFICATION_SERVICE = 'NOTIFICATION';
const NOTIFICATION_PURPOSE = 'NOTIFICATION';
const DOMAIN_PURPOSE = 'NOTIFICATION_REGISTRATION';

/** The context the Gateway issues P1 and P2 for, the only source of form 3 (PRD Tabel 1). */
const SOURCE_SERVICE = 'TRANSACTION';
const SOURCE_PURPOSE = 'PAYMENT_PROCESSING';

export interface TokenServiceDeps {
  readonly operation: AuditedOperation;
  readonly policy: Pick<
    PolicyEngine,
    'authorizeCaller' | 'evaluate' | 'exchangeTarget' | 'exchangeAllowed'
  >;
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
  transaction_id: string | null;
  status: StoredStatus;
  expires_at: Date;
  purged_at: Date | null;
}

interface TransactionSourceRow {
  id: string;
  pseudonym: string;
  subject_type: string;
  subject_id_enc: Buffer | null;
  purged_at: Date | null;
  status: StoredStatus;
  expires_at: Date;
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
    return this.deps.operation.run<TokenResult>(async (tx) => {
      const { result, entry } = await this.generateIn(tx, request);
      return { result, audit: entry };
    });
  }

  /**
   * ADR-0019: the P1 and P2 tokens of one payment in one transaction. Every element goes through the same steps as
   * `generate` (policy STEP 0, lock, issue, link) and leaves its own SUCCESS row; a refusal of any element rolls the
   * whole batch back and leaves one DENIED row for that element, so no token is issued without its pair. At most one
   * element per subject type, and the work is done in the order of the subject type, not of the request: two batches
   * that name the same pair in opposite order would otherwise take the advisory locks in opposite order (deadlock).
   * The results follow the order of the request.
   */
  async generateBatch(requests: readonly GenerateRequest[]): Promise<readonly TokenResult[]> {
    if (requests.length < 1 || requests.length > MAX_BATCH)
      throw new DomainError('VALIDATION_ERROR');
    for (const request of requests) assertGenerate(request);
    if (new Set(requests.map((request) => request.subjectType)).size !== requests.length) {
      throw new DomainError('VALIDATION_ERROR');
    }
    const order = requests
      .map((request, index) => ({ request, index }))
      .sort((a, b) => a.request.subjectType.localeCompare(b.request.subjectType));
    return this.deps.operation.run<readonly TokenResult[]>(async (tx) => {
      const results: TokenResult[] = [];
      const entries: SuccessEntry[] = [];
      for (const { request, index } of order) {
        const { result, entry } = await this.generateIn(tx, request);
        results[index] = result;
        entries.push(entry);
      }
      const [first, ...rest] = entries;
      if (first === undefined) throw new DomainError('INTERNAL_ERROR', 'batch_empty');
      return { result: results, audit: [first, ...rest] };
    });
  }

  /** Spec 7.3 for one identity, inside the transaction the caller opened. */
  private async generateIn(
    tx: OperationTx,
    request: GenerateRequest,
  ): Promise<{ result: TokenResult; entry: SuccessEntry }> {
    const base = baseOf('GENERATE_TOKEN', request);
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
    await this.link(tx, base, {}, issued, {
      transactionId: request.transactionId,
      subjectType: request.subjectType,
      serviceId: request.targetService,
      purpose: request.purpose,
    });
    return { result: resultOf(issued), entry: successEntry(base, issued) };
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
      const { source, named } = await this.ownedSource(
        tx,
        TOKEN_SQL.findSource,
        request,
        base,
        presented,
      );
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
      await this.link(tx, base, presented, issued, {
        transactionId: request.transactionId,
        subjectType: source.subject_type,
        serviceId: request.targetService,
        purpose: request.purpose,
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
      // K-29: an identity whose token was revoked does not give birth to a new token. Expired is fine (spec 7.4).
      const sourceStatus = effectiveStatus(
        { status: source.status, expiresAt: source.expires_at },
        this.deps.clock.now(),
        this.deps.graceSeconds,
      );
      if (sourceStatus === 'revoked') throw denied(base, 'REVOKED', { mappingId: source.id });

      // STEP 2 (the subject is decrypted inside and never leaves) and STEP 3 (buat_token), PRD 6.1.
      const issued = await this.issueFromSource(tx, source, source.subject_id_enc, {
        targetService: request.targetService,
        purpose: request.purpose,
        transactionId: request.transactionId,
        ttlSeconds: context.ttlSeconds,
      });
      await this.link(tx, base, {}, issued, {
        transactionId: request.transactionId,
        subjectType: source.subject_type,
        serviceId: request.targetService,
        purpose: request.purpose,
      });
      return { result: resultOf(issued), audit: successEntry(base, issued) };
    });
  }

  /** Resolve-domain (NOTIFICATION only; Tabel 3): spec 7.6, PRD 7.3. The answer is a P5 pseudonym, never a subject id. */
  async resolveDomain(request: ResolveDomainRequest): Promise<ResolveDomainResult> {
    assertResolveDomain(request);
    const base = baseOf('RESOLVE_NOTIF_DOMAIN', request);
    const presented = { pseudonym: request.notifToken };
    return this.deps.operation.run<ResolveDomainResult>(async (tx) => {
      // STEP 0: the caller, before any token is read, so another service learns nothing about which tokens exist.
      decide(base, presented, () => {
        this.deps.policy.authorizeCaller('RESOLVE_NOTIF_DOMAIN', request.requestingService);
      });

      // STEP 1, one gate after the other, each refusal the first that applies.
      const { source, named } = await this.ownedSource(
        tx,
        TOKEN_SQL.findSource,
        { requestingService: request.requestingService, sourcePseudonym: request.notifToken },
        base,
        presented,
      );
      const known = { ...base, purpose: source.purpose };
      if (source.purpose !== NOTIFICATION_PURPOSE) throw denied(known, 'PURPOSE_MISMATCH', named);
      const status = effectiveStatus(
        { status: source.status, expiresAt: source.expires_at },
        this.deps.clock.now(),
        this.deps.graceSeconds,
      );
      if (status === 'revoked') throw denied(known, 'REVOKED', named);
      if (status === 'expired') throw denied(known, 'EXPIRED', named);
      // Retention empties the identity of an old row; without it there is no subject to look the P5 token up by.
      if (source.subject_id_enc === null || source.purged_at !== null) {
        throw denied(known, 'TOKEN_NOT_FOUND', named);
      }

      // STEP 2 and 3: only a P5 token that is active now; one past its TTL is not handed out.
      const found = await tx.query<{ pseudonym: string; expires_at: Date }>(TOKEN_SQL.findDomain, [
        source.id,
        NOTIFICATION_SERVICE,
        DOMAIN_PURPOSE,
      ]);
      const domain = found.rows[0];
      if (domain === undefined || domain.expires_at.getTime() <= this.deps.clock.now().getTime()) {
        throw denied(known, 'TOKEN_NOT_FOUND', named);
      }
      return {
        result: { notificationDomainId: domain.pseudonym },
        audit: {
          ...known,
          status: 'SUCCESS',
          reason: 'OK',
          pseudonym: request.notifToken,
          mappingId: source.id,
        },
      };
    });
  }

  /** Re-issue (TRANSACTION only; Tabel 3): spec 7.7, PRD 7.5. The service, purpose and subject of the token do not change. */
  async reIssue(request: ReIssueRequest): Promise<TokenResult> {
    assertReIssue(request);
    const base = baseOf('RE_ISSUE', request);
    const presented = { pseudonym: request.pseudonym };
    return this.deps.operation.run<TokenResult>(async (tx) => {
      // The caller first, before any token is read (AZ-23): another service learns nothing about which tokens exist.
      // PRD 7.5 reads the token first; the answer to a caller that is not TRANSACTION is POLICY_NOT_ALLOWED either way.
      decide(base, presented, () => {
        this.deps.policy.authorizeCaller('RE_ISSUE', request.requestingService);
      });

      // STEP 1: the token exists and is the caller's. FOR UPDATE: this transaction updates the row.
      const { source, named } = await this.ownedSource(
        tx,
        TOKEN_SQL.findSourceForUpdate,
        { requestingService: request.requestingService, sourcePseudonym: request.pseudonym },
        base,
        presented,
      );
      const known = { ...base, purpose: source.purpose };
      // Only P1 and P2, and a revoked token is not given a successor. An expired one is exactly what is re-issued.
      const context = decide(known, named, () =>
        this.deps.policy.evaluate({
          operation: 'RE_ISSUE',
          requestingService: request.requestingService,
          context: {
            serviceId: source.service_id,
            purpose: source.purpose,
            subjectType: source.subject_type,
          },
        }),
      );
      const status = effectiveStatus(
        { status: source.status, expiresAt: source.expires_at },
        this.deps.clock.now(),
        this.deps.graceSeconds,
      );
      if (status === 'revoked') throw denied(known, 'REVOKED', named);
      if (source.subject_id_enc === null || source.purged_at !== null) {
        throw denied(known, 'TOKEN_NOT_FOUND', named);
      }

      // STEP 2: a transaction that is not final (no row means not final). Read under a share lock, so a status that
      // becomes final while this runs is seen.
      const transaction = await tx.query<{ status: string }>(TRANSACTION_STATUS_SQL.readShared, [
        request.transactionId,
      ]);
      const current = transaction.rows[0];
      if (current !== undefined && isTerminal(current.status)) {
        throw denied(known, 'TX_TERMINAL', named);
      }

      // STEP 3 and 4: the old token expires, then buat_token under the lock of the combination. A second call finds the
      // old token already expired and the new one active, and gives it back.
      await tx.query(TOKEN_SQL.markExpired, [source.id]);
      const issued = await this.issueFromSource(tx, source, source.subject_id_enc, {
        targetService: source.service_id,
        purpose: source.purpose,
        // K-28 (d): the row keeps the transaction id it was first issued for; the link below carries this request's.
        transactionId: source.transaction_id ?? request.transactionId,
        ttlSeconds: context.ttlSeconds,
      });
      await this.link(
        tx,
        known,
        named,
        issued,
        {
          transactionId: request.transactionId,
          subjectType: source.subject_type,
          serviceId: source.service_id,
          purpose: source.purpose,
        },
        request.pseudonym,
      );
      return { result: resultOf(issued), audit: successEntry(known, issued) };
    });
  }

  /**
   * K-28, ADR-0013: ties the transaction id to the token this operation issued or gave back, in the context it was
   * issued for. A repeat is a no-op; another token for the same transaction id and context is a conflict
   * (IDEMPOTENCY_CONFLICT, audited, the whole operation rolled back). A re-issue (`supersedes`) never creates a link:
   * it may only move the link that already points to the token it replaces, so a transaction id taken from the body
   * cannot plant a link in the context Gateway issues from (form 3 reads it).
   */
  private async link(
    tx: OperationTx,
    base: AuditBase,
    named: { pseudonym?: string; mappingId?: string },
    issued: Issued,
    key: {
      transactionId: string | undefined;
      subjectType: string;
      serviceId: string;
      purpose: string;
    },
    supersedes?: string,
  ): Promise<void> {
    if (key.transactionId === undefined) return;
    const where = [key.transactionId, key.subjectType, key.serviceId, key.purpose];
    // Twice at most: the second round is for a link that retention removed between the insert and the read.
    for (let round = 0; round < 2; round += 1) {
      if (supersedes === undefined) {
        const inserted = await tx.query(TOKEN_SQL.insertLink, [
          ...where,
          issued.pseudonym,
          this.deps.clock.now(),
        ]);
        if (inserted.rowCount === 1) return;
      }
      const found = await tx.query<{ pseudonym: string }>(TOKEN_SQL.findLink, where);
      const existing = found.rows[0]?.pseudonym;
      if (existing === undefined) {
        if (supersedes !== undefined) throw denied(base, 'IDEMPOTENCY_CONFLICT', named);
        continue;
      }
      if (existing === issued.pseudonym) return;
      if (supersedes !== undefined && existing === supersedes) {
        await tx.query(TOKEN_SQL.moveLink, [...where, issued.pseudonym, supersedes]);
        return;
      }
      throw denied(base, 'IDEMPOTENCY_CONFLICT', named);
    }
    throw new DomainError('INTERNAL_ERROR', 'link_retry');
  }

  /** STEP 1 of exchange and re-issue: the presented token exists and belongs to the caller. */
  private async ownedSource(
    tx: OperationTx,
    sql: string,
    request: { requestingService: string; sourcePseudonym: string },
    base: AuditBase,
    presented: { pseudonym: string },
  ): Promise<{ source: SourceRow; named: { pseudonym: string; mappingId: string } }> {
    const found = await tx.query<SourceRow>(sql, [request.sourcePseudonym]);
    const source = found.rows[0];
    if (source === undefined) throw denied(base, 'TOKEN_NOT_FOUND', presented);
    const named = { ...presented, mappingId: source.id };
    if (source.service_id !== request.requestingService) {
      throw denied(base, 'SERVICE_MISMATCH', named);
    }
    return { source, named };
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
    const found = await tx.query<ActiveRow>(TOKEN_SQL.expireAndFindActive, [
      lookup,
      targetService,
      purpose,
      now,
    ]);
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
