export const DAY_MS = 86_400_000;
const RUN_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * When the daily retention job runs next (K-26, spec privacy 7.11): the first `HH:MM` UTC (RETENTION_JOB_RUN_UTC,
 * default 01:00) strictly after `now`, so a job that has just run at that minute waits for tomorrow. Everything is UTC
 * (NFR-20); the clock is the caller's.
 */
export function nextRunAt(now: Date, runUtc: string): Date {
  const match = RUN_TIME.exec(runUtc);
  if (match === null) throw new RangeError('the run time must be HH:MM in UTC');
  if (Number.isNaN(now.getTime())) throw new RangeError('invalid instant');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes);
  return new Date(today > now.getTime() ? today : today + DAY_MS);
}
