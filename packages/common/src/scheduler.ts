import { z } from 'zod';
import type { Clock } from './clock';
import { loadConfig, type EnvSource } from './config';
import { DomainError } from './errors';
import type { Logger } from './logger';

export const DAY_MS = 86_400_000;
const RUN_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** `HH:MM` in UTC: the one shape of a daily job's time, for the schedule and for the environment variable that sets it. */
export const runTimeUtc = z.string().regex(RUN_TIME);
/** The longest a timer sleeps: a clock that was set, or a job added late, is noticed within the hour. */
const MAX_WAIT_MS = 3_600_000;

/**
 * When a daily job runs next (K-23, K-26): the first `HH:MM` UTC strictly after `now`, so a job that has just run at that
 * minute waits for tomorrow. Everything is UTC (NFR-20); the clock is the caller's.
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

export type Schedule =
  | { readonly kind: 'every'; readonly seconds: number }
  | { readonly kind: 'daily'; readonly runUtc: string };

export interface Job {
  /** Appears in the log line of a failure, so it is a fixed word and never a value. */
  readonly name: string;
  readonly schedule: Schedule;
  run(): Promise<unknown>;
}

/** The timer, injected so a test fires it by hand and never waits. */
export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // A timer alone does not keep the process alive: the server does that, and a stop must not wait for the next run.
    handle.unref();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** What a service hands to the shared skeleton (`SCHEDULER`): started once it listens, stopped before its resources. */
export interface BackgroundWork {
  start(): void;
  stop(): Promise<void>;
}
export const SCHEDULER = Symbol.for('privpay.scheduler');

export interface SchedulerOptions {
  readonly clock: Clock;
  /** Only a job name and a reason are ever logged (invariant 6). */
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly jobs: readonly Job[];
  readonly timers?: Timers | undefined;
}

interface Entry {
  readonly job: Job;
  nextDue: Date;
  running: Promise<void> | undefined;
}

const dueAfter = (schedule: Schedule, now: Date): Date => {
  if (schedule.kind === 'daily') return nextRunAt(now, schedule.runUtc);
  if (!Number.isSafeInteger(schedule.seconds) || schedule.seconds < 1) {
    throw new RangeError('an interval is a whole number of seconds, at least 1');
  }
  return new Date(now.getTime() + schedule.seconds * 1000);
};

/**
 * The one way a service runs something on a schedule (M4-10): each job on its own interval or time of day, started once
 * the service listens and stopped, running jobs waited for, before its resources close. A job never runs twice at once
 * (an occurrence that comes while it runs is skipped, not queued), an error in a job is logged by name and reason and
 * goes no further, and a missed occurrence is not made up. It assumes one instance of the service: two would both run
 * every job (PRD 20, single instance).
 */
export class Scheduler implements BackgroundWork {
  private readonly entries: Entry[];
  private readonly timers: Timers;
  private timer: unknown;
  private started = false;
  private stopped = false;

  constructor(private readonly options: SchedulerOptions) {
    this.timers = options.timers ?? realTimers;
    const names = new Set<string>();
    const now = options.clock.now();
    this.entries = options.jobs.map((job) => {
      if (names.has(job.name)) throw new RangeError('two jobs have the same name');
      names.add(job.name);
      // Fail fast: an interval or a time of day that cannot work is refused here, not at the first run.
      return { job, nextDue: dueAfter(job.schedule, now), running: undefined };
    });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const now = this.options.clock.now();
    for (const entry of this.entries) entry.nextDue = dueAfter(entry.job.schedule, now);
    this.arm();
  }

  /** The jobs and when they run, for a test and for a look at what a service was built with. */
  describe(): readonly { name: string; schedule: Schedule }[] {
    return this.entries.map((entry) => ({ name: entry.job.name, schedule: entry.job.schedule }));
  }

  /** Cancels the timer, starts nothing more, and resolves when every job that was running has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    await this.idle();
  }

  /** Resolves when no job is running; for the stop and for tests. */
  async idle(): Promise<void> {
    for (;;) {
      const running = this.entries.flatMap((entry) =>
        entry.running === undefined ? [] : [entry.running],
      );
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  private arm(): void {
    if (this.stopped || this.entries.length === 0) return;
    const now = this.options.clock.now().getTime();
    const earliest = Math.min(...this.entries.map((entry) => entry.nextDue.getTime()));
    const wait = Math.min(Math.max(earliest - now, 0), MAX_WAIT_MS);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.tick();
    }, wait);
  }

  /** Starts what is due, synchronously, and arms the timer for the next time. */
  private tick(): void {
    if (this.stopped) return;
    const now = this.options.clock.now();
    for (const entry of this.entries) {
      if (entry.nextDue.getTime() > now.getTime()) continue;
      entry.nextDue = dueAfter(entry.job.schedule, now);
      // Still running from an earlier occurrence: this one is skipped, and said so.
      if (entry.running === undefined) this.launch(entry);
      else this.options.logger.warn(`job_skipped_${entry.job.name}`);
    }
    this.arm();
  }

  private launch(entry: Entry): void {
    const work = (async () => {
      try {
        await entry.job.run();
      } catch (error) {
        // The message of an error may hold a value; only the reason of one of ours is kept. A log that cannot be
        // written is not allowed to become an unhandled rejection that takes the process down.
        try {
          this.options.logger.warn(`job_failed_${entry.job.name}`, {
            reason: error instanceof DomainError ? error.reason : 'INTERNAL_ERROR',
          });
        } catch {
          // Nothing left to tell: the job runs again at its next time.
        }
      }
    })();
    const tracked = work.finally(() => {
      if (entry.running === tracked) entry.running = undefined;
    });
    entry.running = tracked;
  }
}

const schedulerSwitch = z.object({ SCHEDULER_ENABLED: z.enum(['true', 'false']).optional() });
/** Shape to spread into a service's own schema, so a bad value stops the start with the other problems. */
export const schedulerConfigShape = schedulerSwitch.shape;

/**
 * Whether the jobs run. Off by default under `NODE_ENV=test`, so no test starts a job by accident, and on elsewhere;
 * `SCHEDULER_ENABLED=true` or `false` decides either way. Any other value stops the start.
 */
export function schedulerEnabled(env: EnvSource): boolean {
  const { SCHEDULER_ENABLED: explicit } = loadConfig(schedulerSwitch, env);
  if (explicit !== undefined) return explicit === 'true';
  return (env['NODE_ENV'] ?? '').trim().toLowerCase() !== 'test';
}

/**
 * What a service puts in its providers: the scheduler under `SCHEDULER` when the jobs are on, nothing when they are off.
 * The scheduler is always built, so a schedule that cannot work stops the start even where the jobs are off.
 */
export function schedulerProviders(
  env: EnvSource,
  options: SchedulerOptions,
): { provide: symbol; useValue: Scheduler }[] {
  const scheduler = new Scheduler(options);
  if (schedulerEnabled(env)) return [{ provide: SCHEDULER, useValue: scheduler }];
  options.logger.info('scheduler_off');
  return [];
}
