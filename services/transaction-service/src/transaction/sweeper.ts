import type { Clock, Logger } from '@privpay/common';
import { reasonOf } from './followups';
import type { PrivacyStatusClient } from './ports';
import type { TransactionRepository } from './repository';

export interface PendingSweeperDeps {
  readonly repository: Pick<TransactionRepository, 'sweepPending'>;
  readonly clock: Clock;
  readonly privacy: PrivacyStatusClient;
  /** TX_PENDING_TIMEOUT_SECONDS (PRD 17). */
  readonly timeoutSeconds: number;
  readonly logger: Pick<Logger, 'warn'>;
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
    for (const transactionId of swept) {
      try {
        await this.deps.privacy.patchStatus(transactionId, 'FAILED');
      } catch (error) {
        this.deps.logger.warn('status_patch_failed', {
          transaction_id: transactionId,
          reason: reasonOf(error),
        });
      }
    }
    return swept.length;
  }
}
