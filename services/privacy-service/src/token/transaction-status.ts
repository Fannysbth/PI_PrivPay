import { DomainError, type Clock } from '@privpay/common';
import type { Pool } from 'pg';
import { AUDIT_FORMATS } from '../audit';
import type { PolicyEngine } from '../policy';

export const TRANSACTION_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** Spec privacy 8: a final status; the transaction can no longer be re-issued and its status no longer changes. */
export const TERMINAL_STATUSES: readonly TransactionStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export const isTerminal = (status: string): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

export const TRANSACTION_STATUS_SQL = {
  // One statement, so two calls at once cannot both pass a check and then both write: a row in a final status is not
  // updated and returns nothing (K-09).
  upsert: `INSERT INTO transaction_status (transaction_id, status, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (transaction_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
     WHERE NOT (transaction_status.status = ANY($4::text[]))
     RETURNING transaction_id, status, updated_at`,
  read: `SELECT transaction_id, status, updated_at FROM transaction_status WHERE transaction_id = $1`,
  // Re-issue reads it under a share lock: a status that becomes final while the re-issue runs is not missed.
  readShared: `SELECT status FROM transaction_status WHERE transaction_id = $1 FOR SHARE`,
} as const;

export interface TransactionStatusRequest {
  /** From the `azp` claim of the service token, never from a body (invariant 7). */
  readonly requestingService: string;
  readonly transactionId: string;
  readonly status: TransactionStatus;
}

export interface TransactionStatusResult {
  readonly transactionId: string;
  readonly status: TransactionStatus;
  readonly updatedAt: Date;
}

interface StatusRow {
  transaction_id: string;
  status: TransactionStatus;
  updated_at: Date;
}

const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;
const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');

function assertShape(request: TransactionStatusRequest): void {
  const { requestingService, transactionId, status } = request;
  if (typeof requestingService !== 'string' || !SERVICE_ID.test(requestingService)) throw invalid();
  if (typeof transactionId !== 'string' || !AUDIT_FORMATS.transactionId.test(transactionId)) {
    throw invalid();
  }
  if (!(TRANSACTION_STATUSES as readonly unknown[]).includes(status)) throw invalid();
}

const toResult = (row: StatusRow): TransactionStatusResult => ({
  transactionId: row.transaction_id,
  status: row.status,
  updatedAt: row.updated_at,
});

/**
 * PATCH /transaction-status (spec privacy 4.7): the status Privacy keeps so that re-issue knows whether a transaction is
 * final. An idempotent upsert; a final status is never left (K-09), and repeating the same final status answers with the
 * row as it is. It is not audited: it is not a token operation (PRD Tabel 3), refusals included.
 */
export class TransactionStatusService {
  constructor(
    private readonly deps: {
      readonly pool: Pick<Pool, 'query'>;
      readonly policy: Pick<PolicyEngine, 'authorizeCaller'>;
      readonly clock: Clock;
    },
  ) {}

  async update(request: TransactionStatusRequest): Promise<TransactionStatusResult> {
    assertShape(request);
    this.deps.policy.authorizeCaller('UPDATE_TX_STATUS', request.requestingService);
    const written = await this.deps.pool.query<StatusRow>(TRANSACTION_STATUS_SQL.upsert, [
      request.transactionId,
      request.status,
      this.deps.clock.now(),
      TERMINAL_STATUSES,
    ]);
    const row = written.rows[0];
    if (row !== undefined) return toResult(row);

    // Nothing was written: the row is in a final status. The same status again is a repeat, anything else is refused.
    const existing = await this.deps.pool.query<StatusRow>(TRANSACTION_STATUS_SQL.read, [
      request.transactionId,
    ]);
    const current = existing.rows[0];
    if (current === undefined) throw new DomainError('INTERNAL_ERROR', 'status_row_missing');
    if (current.status === request.status) return toResult(current);
    throw new DomainError('TX_TERMINAL');
  }
}
