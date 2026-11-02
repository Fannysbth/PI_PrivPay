import { decodeCursor, encodeCursor } from './cursor';
import { DAY_MS, DomainError } from '@privpay/common';
import type { CompletedItem, TransactionDetail, TransactionRepository } from './repository';

/** What Reconciliation reads of one transaction; in baseline also the account number (N-46) and the identity (G5). */
export type TransactionDetailAnswer = TransactionDetail & {
  readonly account_number?: string;
  readonly customer_id?: string;
  readonly nik?: string;
  readonly nama?: string;
};

export interface CompletedPage {
  readonly items: readonly CompletedItem[];
  readonly next_cursor: string | null;
}

/**
 * What Reconciliation reads from Transaction (spec transaction 3.4, K-18): amounts and times, never a token and never
 * an identity. A transaction that is HELD or FAILED is not in it, so a day's total is only what was really completed.
 * The exception is baseline (N-46): there is no Privacy to turn a transaction into an account, so the detail carries the
 * account number Reconciliation needs to match the bank's report. `discloseAccount` is set by the bootstrap of that mode.
 */
export class TransactionReads {
  constructor(
    private readonly deps: {
      readonly repository: Pick<
        TransactionRepository,
        'listCompleted' | 'listCompletedWithIdentity' | 'findDetail' | 'findDetailWithAccount'
      >;
      readonly discloseAccount: boolean;
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
    // G5: where the account number is disclosed (N-46) the identity goes with it, as a conventional system keeps it.
    const rows = this.deps.discloseAccount
      ? await this.deps.repository.listCompletedWithIdentity(from, to, query.limit + 1, after)
      : await this.deps.repository.listCompleted(from, to, query.limit + 1, after);
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
  async detail(transactionId: string): Promise<TransactionDetailAnswer> {
    if (!this.deps.discloseAccount) {
      const found = await this.deps.repository.findDetail(transactionId);
      if (found === undefined) throw new DomainError('TRANSACTION_NOT_FOUND');
      return found;
    }
    const found = await this.deps.repository.findDetailWithAccount(transactionId);
    if (found === undefined) throw new DomainError('TRANSACTION_NOT_FOUND');
    const { accountRef, customerRef, holderNik, holderNama, ...detail } = found;
    return {
      ...detail,
      account_number: accountRef,
      ...(customerRef === undefined ? {} : { customer_id: customerRef }),
      ...(holderNik === undefined ? {} : { nik: holderNik }),
      ...(holderNama === undefined ? {} : { nama: holderNama }),
    };
  }
}
