import { randomUUID } from 'node:crypto';
import { DomainError } from '@privpay/common';
import type { Pool, PoolClient } from 'pg';
import type { ReconItem } from './reconciler';

/** One line of the bank's report as it arrives from the Gateway: a token, never an account number (FR-32). */
export interface ReportItem {
  readonly accountPseudonym: string;
  readonly amount: number;
  readonly bankReference: string;
}

/** What a run decided about its batch (spec reconciliation 3.2 steps 3 and 4). */
export interface BatchOutcome {
  readonly matchedItemIds: readonly string[];
  /** G5: the holder of each matched item that has one; stored only where the mode has the columns. */
  readonly holders?: readonly {
    readonly itemId: string;
    readonly customerId: string | null;
    readonly nik: string | null;
    readonly nama: string | null;
  }[];
  readonly txCount: number;
  readonly totalAmount: number;
  readonly status: 'MATCHED' | 'PARTIAL' | 'MISMATCHED';
}

export type AuditReason = 'AMOUNT_MISMATCH' | 'DISPUTE' | 'OTHER';

export const batchIdOf = (date: string): string => `B-${date.replaceAll('-', '')}`;

/** Every value is a bind parameter (project rules). */
export const RECON_SQL = {
  // A batch exists as soon as there is a report or a run for its date. Until a run says more it counts nothing, which
  // is the weakest status (the column has no "not run yet", PRD 11); the run overwrites all three values.
  ensureBatch: `INSERT INTO settlement_batches (batch_id, batch_date, tx_count, total_amount, status, created_at)
     VALUES ($1, $2, 0, 0, 'MISMATCHED', $3) ON CONFLICT (batch_id) DO NOTHING`,
  // The row lock is what lets a report and a run (and two reports) take turns on one date.
  lockBatch: 'SELECT batch_id FROM settlement_batches WHERE batch_id = $1 FOR UPDATE',
  markMatched: 'UPDATE settlement_items SET matched = (id = ANY($2::uuid[])) WHERE batch_id = $1',
  // Spec reconciliation 3.3: one row per request, a coded reason and the actor, never a free text. The application role
  // can insert and nothing else, so the id is made here and no RETURNING is needed.
  insertAudit: `INSERT INTO audit_requests (request_id, transaction_id, reason_code, actor_id, requested_at)
     VALUES ($1, $2, $3, $4, $5)`,
  // A report that arrives after a run makes the run's counts out of date: back to the weakest status until the next run.
  resetBatch: `UPDATE settlement_batches SET tx_count = 0, total_amount = 0, status = 'MISMATCHED'
     WHERE batch_id = $1`,
  updateBatch: `UPDATE settlement_batches SET tx_count = $2, total_amount = $3, status = $4
     WHERE batch_id = $1`,
} as const;

/**
 * ADR-0006: the two statements that name the account column of an item, the only SQL that differs between the modes.
 * The folder of each mode (`proposed/`, `baseline/`) supplies them; the repository below is one code for both. The
 * account comes back as `account_ref`: a token in proposed, the account number itself in baseline.
 */
export interface SubjectSql {
  readonly items: string;
  readonly insertItems: string;
  // G5, G6: where the mode keeps who a matched item belongs to. `clear` runs first so that a run replaces the earlier one;
  // `set` takes the item ids, customer ids, NIKs and names as four parallel arrays after the batch id. Absent in proposed.
  readonly storeHolders?: { readonly clear: string; readonly set: string };
}

interface ItemRow {
  id: string;
  account_ref: string;
  amount: string;
  bank_reference: string;
}

const toItem = (row: ItemRow): ReconItem => ({
  id: row.id,
  accountPseudonym: row.account_ref,
  // NUMERIC(18,2) comes back as text; the amounts of this platform are whole rupiah (qa C-12).
  amount: Number(row.amount),
  bankReference: row.bank_reference,
});

const signature = (item: { accountPseudonym: string; amount: number; bankReference: string }) =>
  `${item.bankReference}|${item.accountPseudonym}|${String(item.amount)}`;

/**
 * The repository of the seam (ADR-0006). It knows no mode: an item names its account by token in proposed and by the
 * account number in baseline, and the SQL that names the column is handed in by the adapter of the mode. The field
 * `accountPseudonym` of the domain holds whichever the mode stores.
 */
export class ReconciliationRepository {
  constructor(
    private readonly pool: Pick<Pool, 'connect' | 'query'>,
    private readonly subject: SubjectSql,
  ) {}

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockedBatch(client: PoolClient, date: string, now: Date): Promise<string> {
    const batchId = batchIdOf(date);
    await client.query(RECON_SQL.ensureBatch, [batchId, date, now]);
    await client.query(RECON_SQL.lockBatch, [batchId]);
    return batchId;
  }

  private async itemsOf(client: PoolClient, batchId: string): Promise<ReconItem[]> {
    const found = await client.query<ItemRow>(this.subject.items, [batchId]);
    return found.rows.map(toItem);
  }

  /**
   * Spec reconciliation 3.1, K-22: one report per date. The first one is stored (`CREATED`); the same content again
   * answers `SAME`; different content is `IDEMPOTENCY_CONFLICT` and changes nothing. A batch that a run made without
   * any report has no items, so the report that comes late is the first one.
   */
  async storeReport(
    date: string,
    items: readonly ReportItem[],
    now: Date,
  ): Promise<'CREATED' | 'SAME'> {
    return this.inTransaction(async (client) => {
      const batchId = await this.lockedBatch(client, date, now);
      const stored = await this.itemsOf(client, batchId);
      if (stored.length === 0) {
        await client.query(this.subject.insertItems, [
          batchId,
          items.map((item) => item.accountPseudonym),
          items.map((item) => item.amount),
          items.map((item) => item.bankReference),
        ]);
        await client.query(RECON_SQL.resetBatch, [batchId]);
        return 'CREATED';
      }
      const same =
        stored.length === items.length &&
        [...stored.map(signature)].sort().join('\n') ===
          [...items.map(signature)].sort().join('\n');
      if (!same) throw new DomainError('IDEMPOTENCY_CONFLICT');
      return 'SAME';
    });
  }

  /**
   * Spec reconciliation 3.2 steps 3 and 4: with the batch locked, `decide` sees the items of the report and says what
   * matched; the flags and the batch are rewritten together, so running a date again replaces the earlier run.
   */
  async settle<T extends BatchOutcome>(
    date: string,
    now: Date,
    decide: (items: readonly ReconItem[]) => T,
  ): Promise<T> {
    return this.inTransaction(async (client) => {
      const batchId = await this.lockedBatch(client, date, now);
      const items = await this.itemsOf(client, batchId);
      const outcome = decide(items);
      await client.query(RECON_SQL.markMatched, [batchId, [...outcome.matchedItemIds]]);
      const storeHolders = this.subject.storeHolders;
      if (storeHolders !== undefined) {
        await client.query(storeHolders.clear, [batchId]);
        const holders = outcome.holders ?? [];
        if (holders.length > 0) {
          await client.query(storeHolders.set, [
            batchId,
            holders.map((holder) => holder.itemId),
            holders.map((holder) => holder.customerId),
            holders.map((holder) => holder.nik),
            holders.map((holder) => holder.nama),
          ]);
        }
      }
      await client.query(RECON_SQL.updateBatch, [
        batchId,
        outcome.txCount,
        outcome.totalAmount,
        outcome.status,
      ]);
      return outcome;
    });
  }

  /** Spec reconciliation 3.3: the record that an audit was asked for. Returns the id of the request. */
  async recordAudit(request: {
    readonly transactionId: string;
    readonly reasonCode: AuditReason;
    readonly actorId: string;
    readonly at: Date;
  }): Promise<string> {
    const requestId = randomUUID();
    await this.pool.query(RECON_SQL.insertAudit, [
      requestId,
      request.transactionId,
      request.reasonCode,
      request.actorId,
      request.at,
    ]);
    return requestId;
  }
}
