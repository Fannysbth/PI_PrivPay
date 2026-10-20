import { DomainError } from '@privpay/common';
import type { Pool, PoolClient } from 'pg';
import { AuditEntryError, type AuditEntry, type SuccessReason } from './audit-entry';
import type { AuditWriter } from './audit-writer';

/**
 * A refusal that must be audited. The operation's own transaction is rolled back, then one DENIED row is written in
 * a short transaction of its own (a rolled-back transaction cannot carry it). A refusal that is not thrown as a
 * `DeniedOperation` leaves no row, so every decision of the spec's gates must be thrown this way.
 */
export class DeniedOperation extends DomainError {
  readonly entry: AuditEntry;

  constructor(entry: AuditEntry) {
    if (entry.status !== 'DENIED' || entry.reason === 'OK' || entry.reason === 'REUSED_ACTIVE') {
      throw new RangeError('a denial needs status DENIED and a reason code');
    }
    super(entry.reason);
    this.name = 'DeniedOperation';
    this.entry = entry;
  }
}

/** The row of a committed operation: SUCCESS with OK or REUSED_ACTIVE, so a state change never carries a DENIED row. */
export type SuccessEntry = Omit<AuditEntry, 'status' | 'reason'> & {
  readonly status: 'SUCCESS';
  readonly reason: SuccessReason;
};

export interface AuditedResult<T> {
  readonly result: T;
  /** The SUCCESS row, written in the same transaction as the state change. */
  readonly audit: SuccessEntry;
}

/**
 * What `work` may use: queries on the operation's transaction. The audit row is not its business (it returns the
 * entry), and the connection is not its to release.
 */
export type OperationTx = Pick<PoolClient, 'query'>;

interface Health {
  /** Set when ROLLBACK itself failed: the connection is then destroyed instead of going back to the pool. */
  broken: boolean;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** `<step>:<SQLSTATE>`: a fixed category an operator can act on, never a message that could carry a value. */
function failure(step: 'audit_write' | 'commit', error: unknown): DomainError {
  if (error instanceof AuditEntryError)
    return new DomainError('INTERNAL_ERROR', `${step}:invalid_entry`);
  const code = (error as { code?: unknown } | null)?.code;
  return new DomainError(
    'INTERNAL_ERROR',
    `${step}:${typeof code === 'string' && SQLSTATE.test(code) ? code : 'none'}`,
  );
}

async function rollback(client: PoolClient, health: Health): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    health.broken = true;
  }
}

/**
 * Runs one operation so that it leaves exactly one audit row (FR-13): the result and its SUCCESS row commit together
 * or not at all, a denial leaves one DENIED row, and when the row cannot be written the operation fails with
 * INTERNAL_ERROR (spec privacy 11: never a success without audit, never a silent denial). A failed COMMIT is
 * reported as a failure even though a lost connection may have committed: the caller cannot know, and a retry is
 * safe because every operation is idempotent by its own key (PRD 7.1).
 *
 * An unexpected error (a bug, not a decision) rolls back and propagates without a row; it is a 500, not a decision.
 */
export class AuditedOperation {
  constructor(
    private readonly pool: Pool,
    private readonly writer: AuditWriter,
  ) {}

  async run<T>(work: (tx: OperationTx) => Promise<AuditedResult<T>>): Promise<T> {
    const client = await this.pool.connect();
    const health: Health = { broken: false };
    try {
      return await this.execute(client, health, work);
    } finally {
      client.release(health.broken ? new Error('connection unusable') : undefined);
    }
  }

  private async execute<T>(
    client: PoolClient,
    health: Health,
    work: (tx: OperationTx) => Promise<AuditedResult<T>>,
  ): Promise<T> {
    await client.query('BEGIN');
    let outcome: AuditedResult<T>;
    try {
      outcome = await work(client);
    } catch (error) {
      await rollback(client, health);
      if (error instanceof DeniedOperation) await this.recordDenial(client, health, error.entry);
      throw error;
    }
    try {
      await this.writer.record(outcome.audit, client);
    } catch (error) {
      await rollback(client, health);
      throw failure('audit_write', error);
    }
    try {
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client, health);
      throw failure('commit', error);
    }
    return outcome.result;
  }

  private async recordDenial(client: PoolClient, health: Health, entry: AuditEntry): Promise<void> {
    try {
      await client.query('BEGIN');
      await this.writer.record(entry, client);
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client, health);
      throw failure('audit_write', error);
    }
  }
}
