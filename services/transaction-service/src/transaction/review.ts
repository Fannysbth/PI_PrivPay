import { DomainError, type Clock, type Logger } from '@privpay/common';
import { Followups, type MutableSubject, type Settled } from './followups';
import type { NotificationClient, PrivacyStatusClient, SubjectReferencePort } from './ports';
import type { HeldCursor, HeldItem, TransactionRepository } from './repository';

export interface TransactionReviewDeps {
  readonly repository: Pick<
    TransactionRepository,
    'listHeld' | 'decideHeld' | 'updateTokens' | 'markPrivacySynced'
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

/** Position text made by this service only: `<time with microseconds>|<transaction id>` in base64url. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(TX-[0-9]{1,29})$/;
const encode = (cursor: HeldCursor): string =>
  Buffer.from(`${cursor.createdAt}|${cursor.transactionId}`, 'utf8').toString('base64url');

function decode(text: string): HeldCursor {
  const match = CURSOR.exec(Buffer.from(text, 'base64url').toString('utf8'));
  // A cursor is only the position this service handed out; anything else is a malformed request, not a search.
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    encode({ createdAt: match[1], transactionId: match[2] }) !== text
  ) {
    throw new DomainError('VALIDATION_ERROR');
  }
  return { createdAt: match[1], transactionId: match[2] };
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
    const after = query.cursor === undefined ? undefined : decode(query.cursor);
    // One more than asked tells whether another page exists without a count query.
    const rows = await this.deps.repository.listHeld(query.limit + 1, after);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => row.item),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encode({ createdAt: last.createdText, transactionId: last.item.transaction_id })
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
