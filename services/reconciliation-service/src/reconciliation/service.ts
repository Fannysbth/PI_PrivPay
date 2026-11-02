import { DomainError, type Clock, type Logger } from '@privpay/common';
import { disclosedAttributes } from './attributes';
import type { Actor, DisclosedAttributes, PrivacyClient, TransactionClient } from './ports';
import { match, type ReconTransaction } from './reconciler';
import type { AuditReason, ReconciliationRepository, ReportItem } from './repository';
import { batchIdOf } from './repository';

export interface ReconciliationServiceDeps {
  readonly repository: Pick<ReconciliationRepository, 'storeReport' | 'settle' | 'recordAudit'>;
  readonly transactions: TransactionClient;
  readonly privacy: PrivacyClient;
  readonly clock: Clock;
  /** Only a transaction id and a reason are ever logged (invariant 6). */
  readonly logger: Pick<Logger, 'warn'>;
}

export interface AuditResult {
  readonly request_id: string;
  readonly transaction_id: string;
  readonly audit_token: string;
  readonly amount: number;
  readonly status: string;
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
      const accountSubjectRef = await this.deps.privacy.accountSubjectRef(
        transaction.transactionId,
      );
      if (accountSubjectRef === null) {
        this.deps.logger.warn('account_token_missing', {
          transaction_id: transaction.transactionId,
        });
      }
      transactions.push({
        transactionId: transaction.transactionId,
        amount: transaction.amount,
        accountSubjectRef,
        ...(transaction.holder === undefined ? {} : { holder: transaction.holder }),
      });
    }

    const outcome = await this.deps.repository.settle(date, this.deps.clock.now(), (items) => {
      const result = match(transactions, items);
      const holderOfTransaction = new Map(
        transactions.map((transaction) => [transaction.transactionId, transaction.holder]),
      );
      return {
        matchedItemIds: result.pairs.map((pair) => pair.itemId),
        holders: result.pairs.flatMap((pair) => {
          const holder = holderOfTransaction.get(pair.transactionId);
          return holder === undefined
            ? []
            : [
                {
                  itemId: pair.itemId,
                  customerId: holder.customerId ?? null,
                  nik: holder.nik ?? null,
                  nama: holder.nama ?? null,
                },
              ];
        }),
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

  /**
   * E1 and E2 (spec reconciliation 3.3): the data of the transaction and a P7 token for the person who asked, nothing
   * that names the customer. The request is recorded once Privacy has issued the token, so a row means a token exists;
   * a refusal is already a DENIED row of Privacy's own audit, with this actor.
   */
  async auditRequest(
    request: { readonly transactionId: string; readonly reasonCode: AuditReason },
    actor: Actor,
  ): Promise<AuditResult> {
    const transaction = await this.deps.transactions.byId(request.transactionId);
    const auditToken = await this.deps.privacy.auditToken(request.transactionId, actor);
    const requestId = await this.deps.repository.recordAudit({
      transactionId: request.transactionId,
      reasonCode: request.reasonCode,
      actorId: actor.actorId,
      at: this.deps.clock.now(),
    });
    return {
      request_id: requestId,
      transaction_id: transaction.transactionId,
      audit_token: auditToken,
      amount: transaction.amount,
      status: transaction.status,
    };
  }

  /**
   * E3 (spec reconciliation 3.4, K-15): hands the request on to Privacy with this person's token and returns what
   * Privacy released. There is no other way to an identity here: no purpose, no attribute list and no requester are
   * the caller's to name, and the answer is kept nowhere (T-14). An answer that is not exactly some of the three
   * attributes of Tabel 5 is not passed on.
   */
  async disclose(
    request: { readonly auditToken: string; readonly disclosureId: string },
    actor: Actor,
  ): Promise<{ attributes: DisclosedAttributes }> {
    const released = await this.deps.privacy.open(request, actor);
    const checked = disclosedAttributes.safeParse(released);
    if (!checked.success || Object.keys(checked.data).length === 0) {
      throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer');
    }
    return { attributes: checked.data };
  }
}
