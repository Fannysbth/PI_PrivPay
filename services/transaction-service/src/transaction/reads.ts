import { decodeCursor, encodeCursor } from './cursor';
import { DomainError } from '@privpay/common';
import type { CompletedItem, TransactionDetail, TransactionRepository } from './repository';

export interface CompletedPage {
  readonly items: readonly CompletedItem[];
  readonly next_cursor: string | null;
}

const DAY_MS = 86_400_000;

/**
 * What Reconciliation reads from Transaction (spec transaction 3.4, K-18): amounts and times, never a token and never
 * an identity. A transaction that is HELD or FAILED is not in it, so a day's total is only what was really completed.
 */
export class TransactionReads {
  constructor(
    private readonly deps: {
      readonly repository: Pick<TransactionRepository, 'listCompleted' | 'findDetail'>;
    },
  ) {}

  /** `date` is `YYYY-MM-DD`, already checked by the caller; the day is that UTC date (NFR-20). */
  async completedOn(
    date: string,
    query: { readonly limit: number; readonly cursor?: string },
  ): Promise<CompletedPage> {
    const from = new Date(`${date}T00:00:00.000Z`);
    const to = new Date(from.getTime() + DAY_MS);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    // One more than asked tells whether another page exists without a count query.
    const rows = await this.deps.repository.listCompleted(from, to, query.limit + 1, after);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => row.item),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.completedText, transactionId: last.item.transaction_id })
          : null,
    };
  }

  /** K-02: a transaction that is not there is `TRANSACTION_NOT_FOUND`, not an empty answer. */
  async detail(transactionId: string): Promise<TransactionDetail> {
    const found = await this.deps.repository.findDetail(transactionId);
    if (found === undefined) throw new DomainError('TRANSACTION_NOT_FOUND');
    return found;
  }
}
