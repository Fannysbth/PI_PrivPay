import { DomainError, type Logger, type Reason } from '@privpay/common';
import {
  privacyStatusOf,
  TokenExpiredError,
  type NotificationClient,
  type NotificationTemplate,
  type PrivacyStatusClient,
  type SubjectReferencePort,
  type SubjectRow,
} from './ports';
import type { TransactionRepository, TransactionStatus } from './repository';

/**
 * The only thing a log line may say about a failure (invariant 6): the reason of a DomainError, or INTERNAL_ERROR for
 * anything else, so a bug in an adapter is not mistaken for a neighbour that is away.
 */
export const reasonOf = (error: unknown): Reason =>
  error instanceof DomainError ? error.reason : 'INTERNAL_ERROR';

export type Settled = Exclude<TransactionStatus, 'PENDING'>;
export type MutableSubject = { -readonly [K in keyof SubjectRow]: SubjectRow[K] };

const TEMPLATES = {
  COMPLETED: 'TX_COMPLETED',
  HELD: 'TX_HELD_VERIFY',
  FAILED: 'TX_REJECTED',
} as const satisfies Record<Settled, NotificationTemplate>;

export interface FollowupsDeps {
  readonly repository: Pick<TransactionRepository, 'updateTokens'>;
  readonly subjects: SubjectReferencePort;
  readonly notifications: NotificationClient;
  readonly privacy: PrivacyStatusClient;
  /** Only the transaction id and a reason are ever logged (invariant 6). */
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * What follows a decision, shared by the winner of a request and by the analyst's review: the status to Privacy (spec
 * transaction 5 step 3) and the message to the customer (step 4). Neither failing changes the status (spec 7).
 */
export class Followups {
  constructor(private readonly deps: FollowupsDeps) {}

  /** The status here stays; Privacy catches up when it can. */
  async patchPrivacy(transactionId: string, status: Settled): Promise<void> {
    try {
      await this.deps.privacy.patchStatus(transactionId, privacyStatusOf(status));
    } catch (error) {
      this.deps.logger.warn('status_patch_failed', {
        transaction_id: transactionId,
        reason: reasonOf(error),
      });
    }
  }

  /** Not retried and not resent: a second call is a second SMS (NFR-12). */
  async notify(subject: MutableSubject, amount: number, status: Settled): Promise<void> {
    try {
      const sent = await this.withReissue(subject, async (row) =>
        this.deps.notifications.send({
          subject: await this.deps.subjects.forNotification(row),
          template: TEMPLATES[status],
          amount,
          transactionId: subject.transactionId,
        }),
      );
      if (sent === 'SENT') return;
      this.deps.logger.warn('notification_failed', {
        transaction_id: subject.transactionId,
        reason: 'SERVICE_UNAVAILABLE',
      });
    } catch (error) {
      this.deps.logger.warn('notification_failed', {
        transaction_id: subject.transactionId,
        reason: reasonOf(error),
      });
    }
  }

  /**
   * TF-04, spec transaction 5 step 5: a token that expired in the middle of the work is issued again and the step
   * tried once more. `row` is updated in place so the later steps use the new tokens. Any other failure, and a
   * second expiry, is the failure of the step.
   */
  async withReissue<T>(row: MutableSubject, step: (row: SubjectRow) => Promise<T>): Promise<T> {
    try {
      return await step({ ...row });
    } catch (error) {
      if (!(error instanceof TokenExpiredError)) throw error;
      const issued = await this.deps.subjects.reissue({ ...row });
      await this.deps.repository.updateTokens(row.transactionId, issued);
      row.customerToken = issued.customerToken;
      row.accountToken = issued.accountToken;
      return step({ ...row });
    }
  }
}
