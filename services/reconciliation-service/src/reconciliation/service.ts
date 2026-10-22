import type { Clock, Logger } from '@privpay/common';
import type { PrivacyClient, TransactionClient } from './ports';
import { match, type ReconTransaction } from './reconciler';
import type { ReconciliationRepository, ReportItem } from './repository';
import { batchIdOf } from './repository';

export interface ReconciliationServiceDeps {
  readonly repository: Pick<ReconciliationRepository, 'storeReport' | 'settle'>;
  readonly transactions: TransactionClient;
  readonly privacy: PrivacyClient;
  readonly clock: Clock;
  /** Only a transaction id and a reason are ever logged (invariant 6). */
  readonly logger: Pick<Logger, 'warn'>;
}

export interface RunResult {
  readonly batch_id: string;
  readonly tx_count: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly status: 'MATCHED' | 'PARTIAL' | 'MISMATCHED';
}

/**
 * The orchestration of D1 to D4 (spec reconciliation 3.1, 3.2). It holds no identity: it asks Transaction for amounts,
 * Privacy for the account token of each transaction, and compares them with the report the Gateway already tokenised.
 */
export class ReconciliationService {
  constructor(private readonly deps: ReconciliationServiceDeps) {}

  /** D3: the report is stored as it is (tokens, amounts, references); a second, different one for the date is refused. */
  async receiveReport(report: {
    readonly batchDate: string;
    readonly items: readonly ReportItem[];
  }): Promise<{ created: boolean; batchDate: string; itemCount: number }> {
    const result = await this.deps.repository.storeReport(
      report.batchDate,
      report.items,
      this.deps.clock.now(),
    );
    return {
      created: result === 'CREATED',
      batchDate: report.batchDate,
      itemCount: report.items.length,
    };
  }

  /**
   * D1 to D4 for one date. Transaction or Privacy that cannot answer stops the run before a batch is touched
   * (K-22, 503); a transaction Privacy has no token for does not (it is counted unmatched), so one item never holds the
   * day back (spec reconciliation 5).
   */
  async run(date: string): Promise<RunResult> {
    const completed = await this.deps.transactions.completedOn(date);
    const transactions: ReconTransaction[] = [];
    for (const transaction of completed) {
      const accountToken = await this.deps.privacy.accountToken(transaction.transactionId);
      if (accountToken === null) {
        this.deps.logger.warn('account_token_missing', {
          transaction_id: transaction.transactionId,
        });
      }
      transactions.push({
        transactionId: transaction.transactionId,
        amount: transaction.amount,
        accountToken,
      });
    }

    const outcome = await this.deps.repository.settle(date, this.deps.clock.now(), (items) => {
      const result = match(transactions, items);
      return {
        matchedItemIds: result.pairs.map((pair) => pair.itemId),
        txCount: transactions.length,
        totalAmount: transactions.reduce((sum, transaction) => sum + transaction.amount, 0),
        status: result.status,
        unmatched: result.unmatchedItems.length + result.unmatchedTransactions.length,
      };
    });
    return {
      batch_id: batchIdOf(date),
      tx_count: outcome.txCount,
      matched: outcome.matchedItemIds.length,
      unmatched: outcome.unmatched,
      status: outcome.status,
    };
  }
}
