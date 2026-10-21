import type { Clock } from '@privpay/common';
import type { Pool } from 'pg';
import { AuditWriter } from '../audit';
import { DAY_MS } from './schedule';

/** Every value is a bind parameter (CLAUDE.md). The predicates are those of PRD 6.2. */
export const RETENTION_SQL = {
  // Step 1: an active row past its TTL and grace period. $1 is now minus the grace period. Rows another transaction holds
  // are skipped too (marked by the next run): a plain UPDATE would queue behind an exchange or a re-issue while holding
  // the locks of the rows it has already reached, and an exchange that marks a row the job holds would wait for the job,
  // a circular wait.
  markExpired: `UPDATE pseudonym_mapping SET status = 'expired'
     WHERE id IN (SELECT id FROM pseudonym_mapping WHERE status = 'active' AND expires_at < $1 FOR UPDATE SKIP LOCKED)`,
  // Step 2, one batch: SKIP LOCKED leaves a row that an exchange, a re-issue or a revocation holds at this moment for the
  // next run, instead of waiting for it. $1 is now minus RETENTION_DAYS, $2 the batch size, $3 now. The identity columns
  // go together (chk_purged); the row stays, so audit_log.mapping_id stays valid; nothing is deleted.
  purgeBatch: `WITH picked AS (
       SELECT id FROM pseudonym_mapping
        WHERE purged_at IS NULL AND status IN ('expired', 'revoked') AND COALESCE(revoked_at, expires_at) < $1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE pseudonym_mapping m
        SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = $3
       FROM picked WHERE m.id = picked.id
     RETURNING m.id, m.pseudonym, m.purpose, m.key_version`,
  // K-28, ADR-0013: a link goes with the identity of its row.
  deleteLinks: 'DELETE FROM transaction_link WHERE pseudonym = ANY($1::text[])',
  // The check of PRD 6.2 (TF-14): no row that stopped being valid long ago still holds an identity.
  overdue: `SELECT count(*) AS n FROM pseudonym_mapping
     WHERE subject_id_enc IS NOT NULL AND status IN ('expired', 'revoked') AND COALESCE(revoked_at, expires_at) < $1`,
} as const;

const DEFAULT_BATCH_SIZE = 500;

export interface RetentionJobDeps {
  readonly pool: Pick<Pool, 'connect' | 'query'>;
  readonly clock: Clock;
  /** GRACE_PERIOD_SECONDS (spec 7.1). */
  readonly graceSeconds: number;
  /** RETENTION_DAYS (PRD 17; 90, set for this research). */
  readonly retentionDays: number;
  /** Rows per transaction (spec 7.11: one transaction per batch). */
  readonly batchSize?: number;
  /** The only path to audit_log; replaceable in a test. */
  readonly writer?: AuditWriter;
}

export interface RetentionResult {
  readonly expired: number;
  readonly purged: number;
}

interface PurgedRow {
  id: string;
  pseudonym: string;
  purpose: string;
  key_version: number;
}

/**
 * The retention job (spec privacy 7.11, PRD 6.2): mark the rows that expired, then empty the identity of the rows that
 * stopped being valid at least RETENTION_DAYS ago, one audit row PURGE_IDENTITY per row (by SYSTEM, naming the mapping
 * and never an identity), in one transaction per batch. The vault is not part of it, and nothing is deleted.
 */
export class RetentionJob {
  private readonly batchSize: number;
  private readonly writer: AuditWriter;

  constructor(private readonly deps: RetentionJobDeps) {
    this.writer = deps.writer ?? new AuditWriter();
    const { graceSeconds, retentionDays } = deps;
    if (
      typeof retentionDays !== 'number' ||
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 1
    ) {
      throw new RangeError('retentionDays must be a positive whole number of days');
    }
    if (typeof graceSeconds !== 'number' || !Number.isFinite(graceSeconds) || graceSeconds < 0) {
      throw new RangeError('graceSeconds must be a non-negative number');
    }
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) {
      throw new RangeError('batchSize must be a positive whole number');
    }
  }

  async run(): Promise<RetentionResult> {
    const now = this.deps.clock.now();
    // Marking by time is not audited (spec 9.1).
    const marked = await this.deps.pool.query(RETENTION_SQL.markExpired, [
      new Date(now.getTime() - this.deps.graceSeconds * 1000),
    ]);
    let purged = 0;
    for (;;) {
      const batch = await this.purgeBatch(now);
      purged += batch;
      if (batch < this.batchSize) break;
    }
    return { expired: marked.rowCount ?? 0, purged };
  }

  /** The rows that the check of PRD 6.2 would still find: zero after a run that was not interrupted by locks. */
  async overdueCount(): Promise<number> {
    const { rows } = await this.deps.pool.query<{ n: string }>(RETENTION_SQL.overdue, [
      this.cutoff(this.deps.clock.now()),
    ]);
    return Number(rows[0]?.n);
  }

  private cutoff(now: Date): Date {
    return new Date(now.getTime() - this.deps.retentionDays * DAY_MS);
  }

  /** One transaction: the rows and their audit rows commit together or not at all (FR-13). */
  private async purgeBatch(now: Date): Promise<number> {
    const client = await this.deps.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query<PurgedRow>(RETENTION_SQL.purgeBatch, [
          this.cutoff(now),
          this.batchSize,
          now,
        ]);
        // K-28, ADR-0013: the links of the emptied rows go in the same transaction; the audit rows stay.
        await client.query(RETENTION_SQL.deleteLinks, [rows.map((row) => row.pseudonym)]);
        for (const row of rows) {
          await this.writer.record(
            {
              action: 'PURGE_IDENTITY',
              status: 'SUCCESS',
              reason: 'OK',
              requestingService: 'PRIVACY_SERVICE',
              actorId: 'SYSTEM',
              pseudonym: row.pseudonym,
              purpose: row.purpose,
              mappingId: row.id,
              keyVersion: row.key_version,
            },
            client,
          );
        }
        await client.query('COMMIT');
        return rows.length;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          broken = new Error('connection unusable');
        });
        throw error;
      }
    } finally {
      client.release(broken);
    }
  }
}
