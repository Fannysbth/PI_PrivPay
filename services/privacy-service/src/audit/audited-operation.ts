import { DomainError } from '@privpay/common';
import type { Pool, PoolClient } from 'pg';
import type { AuditEntry } from './audit-entry';
import type { AuditWriter } from './audit-writer';

/**
 * A refusal that must be audited. The operation's own transaction is rolled back, then one DENIED row is written in
 * a short transaction of its own (a rolled-back transaction cannot carry it).
 */
export class DeniedOperation extends DomainError {
  readonly entry: AuditEntry;

  constructor(entry: AuditEntry) {
    if (entry.status !== 'DENIED' || entry.reason === 'OK') {
      throw new RangeError('a denial needs status DENIED and a reason code');
    }
    super(entry.reason);
    this.name = 'DeniedOperation';
    this.entry = entry;
  }
}

export interface AuditedResult<T> {
  readonly result: T;
  /** The SUCCESS row, written in the same transaction as the state change. */
  readonly audit: AuditEntry;
}

/** A connection that could not even roll back: it is destroyed instead of going back to the pool. */
class ConnectionBroken extends Error {
  constructor(readonly original: unknown) {
    super('rollback failed');
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    throw new ConnectionBroken(error);
  }
}

/**
 * Runs one operation so that it leaves exactly one audit row (FR-13): the result and its SUCCESS row commit together
 * or not at all, a denial leaves one DENIED row, and when the row cannot be written the operation fails with
 * INTERNAL_ERROR (spec privacy 11: never a success without audit, never a silent denial).
 *
 * An unexpected error (a bug, not a decision) rolls back and propagates without a row; it is a 500, not a decision.
 */
export class AuditedOperation {
  constructor(
    private readonly pool: Pool,
    private readonly writer: AuditWriter,
  ) {}

  async run<T>(work: (tx: PoolClient) => Promise<AuditedResult<T>>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      return await this.execute(client, work);
    } catch (error) {
      if (error instanceof ConnectionBroken) {
        broken = error;
        throw error.original;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  private async execute<T>(
    client: PoolClient,
    work: (tx: PoolClient) => Promise<AuditedResult<T>>,
  ): Promise<T> {
    await client.query('BEGIN');
    let outcome: AuditedResult<T>;
    try {
      outcome = await work(client);
    } catch (error) {
      await rollback(client);
      if (error instanceof DeniedOperation) {
        await this.recordDenial(client, error.entry);
      }
      throw error;
    }
    try {
      await this.writer.record(outcome.audit, client);
    } catch {
      await rollback(client);
      throw new DomainError('INTERNAL_ERROR', 'audit_write');
    }
    try {
      await client.query('COMMIT');
    } catch {
      await rollback(client);
      throw new DomainError('INTERNAL_ERROR', 'commit');
    }
    return outcome.result;
  }

  private async recordDenial(client: PoolClient, entry: AuditEntry): Promise<void> {
    try {
      await client.query('BEGIN');
      await this.writer.record(entry, client);
      await client.query('COMMIT');
    } catch {
      await rollback(client);
      throw new DomainError('INTERNAL_ERROR', 'audit_write');
    }
  }
}
