import { DomainError, type Clock, type Logger } from '@privpay/common';
import type { ReconciliationService } from './service';

export const DAY_MS = 86_400_000;
const RUN_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * When the daily run happens next (K-23, spec reconciliation 3.2): the first `HH:MM` UTC (RECON_DAILY_RUN_UTC) strictly
 * after `now`, so a run that has just happened at that minute waits for tomorrow. Everything is UTC (NFR-20); the clock
 * is the caller's.
 */
export function nextRunAt(now: Date, runUtc: string): Date {
  const match = RUN_TIME.exec(runUtc);
  if (match === null) throw new RangeError('the run time must be HH:MM in UTC');
  if (Number.isNaN(now.getTime())) throw new RangeError('invalid instant');
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    Number(match[1]),
    Number(match[2]),
  );
  return new Date(today > now.getTime() ? today : today + DAY_MS);
}

/** The UTC date before `now`, as `YYYY-MM-DD`: what the run at 00:10 reconciles (spec reconciliation 3.2). */
export const previousDate = (now: Date): string =>
  new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);

export interface DailyRunDeps {
  readonly service: Pick<ReconciliationService, 'run'>;
  readonly clock: Clock;
  readonly runUtc: string;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * The scheduled run: yesterday's date through the same `run` as the manual one. A failure (Transaction or Privacy away)
 * is logged by reason and leaves no batch, so the next day's run does not depend on it and a person can run the date
 * again. Nothing here starts a timer: the process lifecycle calls it, the way `RetentionJob` waits for it.
 */
export class DailyRun {
  constructor(private readonly deps: DailyRunDeps) {}

  nextRunAt(): Date {
    return nextRunAt(this.deps.clock.now(), this.deps.runUtc);
  }

  /** Returns the date it ran, or undefined when the run failed. */
  async runPrevious(): Promise<string | undefined> {
    const date = previousDate(this.deps.clock.now());
    try {
      await this.deps.service.run(date);
      return date;
    } catch (error) {
      this.deps.logger.warn('daily_run_failed', {
        reason: error instanceof DomainError ? error.reason : 'INTERNAL_ERROR',
      });
      return undefined;
    }
  }
}
