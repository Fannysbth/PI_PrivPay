import type { Clock, Logger } from '@privpay/common';
import { reasonOf } from './followups';
import { PrivacyRejectedError, privacyStatusOf, type PrivacyStatusClient } from './ports';
import type { TransactionRepository, TransactionStatus } from './repository';

/** How many unheard rows one run repeats; a longer backlog drains over several runs. */
const RESYNC_BATCH = 100;

export interface PendingSweeperDeps {
  readonly repository: Pick<
    TransactionRepository,
    'sweepPending' | 'unsyncedBefore' | 'markPrivacySynced' | 'markPrivacyRejected'
  >;
  readonly clock: Clock;
  readonly privacy: PrivacyStatusClient;
  /** TX_PENDING_TIMEOUT_SECONDS (PRD 17). */
  readonly timeoutSeconds: number;
  readonly logger: Pick<Logger, 'warn'>;
  /** Rows one resync run takes (default 100); a test makes it small to show the queue moving past refused rows. */
  readonly resyncBatch?: number;
}

/**
 * Spec transaction 5 step 6, FR-39: a request that died in the middle leaves a PENDING row; one that is older than
 * the timeout becomes FAILED. A winner still inside its window is not touched. Nothing here schedules the run
 * (`TX_SWEEP_INTERVAL_SECONDS`, K-19): the caller does, the way `RetentionJob` waits for the process lifecycle.
 */
export class PendingSweeper {
  constructor(private readonly deps: PendingSweeperDeps) {}

  /** Returns how many rows it failed. Privacy is told FAILED for each, best effort. */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - this.deps.timeoutSeconds * 1000);
    const swept = await this.deps.repository.sweepPending(cutoff);
    for (const transactionId of swept) await this.tell(transactionId, 'FAILED');
    return swept.length;
  }

  /**
   * What the timer runs (M4-10, K-19): the stale PENDING rows first, then the status Privacy has not heard. In one
   * job, in this order, so the two never work on the same row at the same moment (a row the first just failed and told
   * Privacy about is already marked when the second looks).
   */
  async clean(): Promise<{ failed: number; repaired: number }> {
    const failed = await this.sweep();
    const repaired = await this.resync();
    return { failed, repaired };
  }

  /**
   * Gate 2 decision 1: a final status that Privacy has not heard (its PATCH failed, or the process stopped before it)
   * is sent again, once the request that made it can no longer be working on it. The PATCH is idempotent (privacy
   * spec 4.7), and nothing is sent to the customer here: the message was another step and is never repeated.
   * Returns how many rows Privacy has now heard; the rest are tried again on the next run.
   */
  async resync(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - this.deps.timeoutSeconds * 1000);
    const rows = await this.deps.repository.unsyncedBefore(
      cutoff,
      this.deps.resyncBatch ?? RESYNC_BATCH,
    );
    let heard = 0;
    for (const row of rows) {
      if (await this.tell(row.transactionId, row.status)) heard += 1;
    }
    return heard;
  }

  /** Best effort: true when Privacy answered and the row is marked. */
  private async tell(
    transactionId: string,
    status: Exclude<TransactionStatus, 'PENDING'>,
  ): Promise<boolean> {
    try {
      await this.deps.privacy.patchStatus(transactionId, privacyStatusOf(status));
    } catch (error) {
      if (error instanceof PrivacyRejectedError) {
        await this.markRejected(transactionId, status);
        return false;
      }
      this.deps.logger.warn('status_patch_failed', {
        transaction_id: transactionId,
        reason: reasonOf(error),
      });
      return false;
    }
    try {
      await this.deps.repository.markPrivacySynced(transactionId, status, this.deps.clock.now());
    } catch (error) {
      this.deps.logger.warn('status_mark_failed', {
        transaction_id: transactionId,
        reason: reasonOf(error),
      });
      return false;
    }
    return true;
  }

  /** N-40: stop asking about a row Privacy refuses for good, so it does not hold back the rows after it. */
  private async markRejected(
    transactionId: string,
    status: Exclude<TransactionStatus, 'PENDING'>,
  ): Promise<void> {
    this.deps.logger.warn('status_patch_rejected', { transaction_id: transactionId });
    try {
      await this.deps.repository.markPrivacyRejected(transactionId, status, this.deps.clock.now());
    } catch (error) {
      this.deps.logger.warn('status_mark_failed', {
        transaction_id: transactionId,
        reason: reasonOf(error),
      });
    }
  }
}
