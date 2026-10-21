import type { Clock } from '@privpay/common';

export interface RateLimiterOptions {
  readonly clock: Clock;
  /** `RATE_LIMIT_PER_MINUTE` (PRD 17). */
  readonly limitPerMinute: number;
  /** `RATE_LIMIT_ENABLED`: false only for performance measurement, the same in both modes (platform spec / gateway 7). */
  readonly enabled: boolean;
}

export interface RateDecision {
  readonly allowed: boolean;
  /** Seconds until the next window opens; 0 when the request is allowed. */
  readonly retryAfterSeconds: number;
}

const WINDOW_SECONDS = 60;

/**
 * Fixed one-minute windows counted with the injected clock (FR-26, NFR-08). One process, in memory: the gateway is a
 * single instance in the local phase. A window change drops every count, so memory follows the keys active in the
 * current minute and nothing else.
 */
export class RateLimiter {
  private readonly counts = new Map<string, number>();
  private currentWindow = -1;

  constructor(private readonly options: RateLimiterOptions) {
    const { limitPerMinute } = options;
    if (!Number.isInteger(limitPerMinute) || limitPerMinute < 1) {
      throw new RangeError(
        'the rate limit must be a whole number of requests per minute, at least 1',
      );
    }
  }

  /** Keys currently counted; for tests and metrics. */
  get size(): number {
    return this.counts.size;
  }

  allow(key: string): RateDecision {
    if (!this.options.enabled) return { allowed: true, retryAfterSeconds: 0 };

    const nowSeconds = Math.floor(this.options.clock.now().getTime() / 1000);
    const window = Math.floor(nowSeconds / WINDOW_SECONDS);
    if (window !== this.currentWindow) {
      this.counts.clear();
      this.currentWindow = window;
    }

    const used = this.counts.get(key) ?? 0;
    if (used >= this.options.limitPerMinute) {
      return { allowed: false, retryAfterSeconds: (window + 1) * WINDOW_SECONDS - nowSeconds };
    }
    this.counts.set(key, used + 1);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
