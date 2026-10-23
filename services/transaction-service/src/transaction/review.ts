import { DomainError, type Clock, type Logger } from '@privpay/common';
import { decodeCursor, encodeCursor } from './cursor';
import { Followups, type MutableSubject, type Settled } from './followups';
import type { NotificationClient, PrivacyStatusClient, SubjectReferencePort } from './ports';
import type { HeldItem, TransactionRepository } from './repository';

export interface TransactionReviewDeps {
  readonly repository: Pick<
    TransactionRepository,
    'listHeld' | 'decideHeld' | 'updateTokens' | 'markPrivacySynced' | 'markPrivacyRejected'
  >;
  readonly clock: Clock;
  readonly subjects: SubjectReferencePort;
  readonly notifications: NotificationClient;
  readonly privacy: PrivacyStatusClient;
  readonly logger: Pick<Logger, 'warn'>;
}

export interface HeldPage {
  readonly items: readonly HeldItem[];
  readonly next_cursor: string | null;
}

/**
 * The analyst's side of Transaction (spec transaction 3.2 and 3.3): the list of HELD transactions and the decision on
 * one of them. The role of the person is checked by the caller from the verified token; `reviewedBy` is that token's
 * subject and never a body field (invariant 7).
 */
export class TransactionReview {
  private readonly followups: Followups;

  constructor(private readonly deps: TransactionReviewDeps) {
    this.followups = new Followups(deps);
  }

  async listHeld(query: { readonly limit: number; readonly cursor?: string }): Promise<HeldPage> {
    const position = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const after =
      position === undefined
        ? undefined
        : { createdAt: position.at, transactionId: position.transactionId };
    // One more than asked tells whether another page exists without a count query.
    const rows = await this.deps.repository.listHeld(query.limit + 1, after);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => row.item),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.createdText, transactionId: last.item.transaction_id })
          : null,
    };
  }

  async review(request: {
    readonly transactionId: string;
    readonly decision: 'APPROVE' | 'REJECT';
    readonly reviewedBy: string;
  }): Promise<{ transaction_id: string; status: Settled; reviewed_at: string }> {
    const status: Settled = request.decision === 'APPROVE' ? 'COMPLETED' : 'FAILED';
    const now = this.deps.clock.now();
    const decided = await this.deps.repository.decideHeld(request.transactionId, {
      status,
      fraudDecision: null,
      // Only a completion has a completion time, as for a request that completes by itself.
      completedAt: status === 'COMPLETED' ? now : null,
      reviewedBy: request.reviewedBy,
      reviewedAt: now,
    });
    if (decided === undefined) throw new DomainError('NOT_HELD');

    // The customer is told before Privacy hears the end: a token that expired while the transaction was held can only
    // be issued again while Privacy still sees it as IN_PROGRESS (spec privacy 4.4, TX_TERMINAL).
    const subject: MutableSubject = {
      transactionId: decided.transactionId,
      customerToken: decided.customerToken,
      accountToken: decided.accountToken,
    };
    await this.followups.notify(subject, decided.amount, status);
    await this.followups.patchPrivacy(decided.transactionId, status);
    return { transaction_id: decided.transactionId, status, reviewed_at: now.toISOString() };
  }
}
