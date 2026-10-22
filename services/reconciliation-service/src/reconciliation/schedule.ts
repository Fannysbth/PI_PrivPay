import { DAY_MS } from '@privpay/common';

/** The UTC date before `now`, as `YYYY-MM-DD`: what the run at 00:10 reconciles (spec reconciliation 3.2, K-23). */
export const previousDate = (now: Date): string =>
  new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
