import { FakeClock } from '@privpay/common';
import { RateLimiter } from '../src/rate-limiter';

// Fixed window of one minute, counted with the injected clock (FR-26, NFR-08, TK-11).
const START = new Date('2026-10-19T08:00:20Z');

describe('M1-03 RateLimiter.allow counts requests per key in a fixed one-minute window', () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = new FakeClock(START);
  });
  const limiter = (limitPerMinute = 3, enabled = true): RateLimiter =>
    new RateLimiter({ clock, limitPerMinute, enabled });

  it('M1-03 TK-11 allows the limit and refuses the next request with the time to wait', () => {
    const rate = limiter(3);
    expect([1, 2, 3].map(() => rate.allow('api-gateway:usr-1').allowed)).toEqual([
      true,
      true,
      true,
    ]);
    const refused = rate.allow('api-gateway:usr-1');
    expect(refused.allowed).toBe(false);
    // 20 seconds into the minute: 40 seconds to the next window.
    expect(refused.retryAfterSeconds).toBe(40);
  });

  it('M1-03 a new minute starts a new count', () => {
    const rate = limiter(2);
    rate.allow('k');
    rate.allow('k');
    expect(rate.allow('k').allowed).toBe(false);
    clock.advance(40);
    expect(rate.allow('k').allowed).toBe(true);
    expect(rate.allow('k').allowed).toBe(true);
    expect(rate.allow('k').allowed).toBe(false);
  });

  it('M1-03 the last second of a window and the first of the next are different windows', () => {
    const rate = limiter(1);
    clock.set(new Date('2026-10-19T08:00:59Z'));
    expect(rate.allow('k').allowed).toBe(true);
    expect(rate.allow('k')).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    clock.set(new Date('2026-10-19T08:01:00Z'));
    expect(rate.allow('k').allowed).toBe(true);
  });

  it('M1-03 each key has its own count', () => {
    const rate = limiter(1);
    expect(rate.allow('a').allowed).toBe(true);
    expect(rate.allow('b').allowed).toBe(true);
    expect(rate.allow('a').allowed).toBe(false);
    expect(rate.allow('b').allowed).toBe(false);
  });

  it('M1-03 RATE_LIMIT_ENABLED=false lets everything through and counts nothing', () => {
    const rate = limiter(1, false);
    for (let i = 0; i < 50; i += 1) expect(rate.allow('k').allowed).toBe(true);
    expect(rate.size).toBe(0);
  });

  it('M1-03 counts of past windows are dropped, so memory follows the active keys only', () => {
    const rate = limiter(5);
    for (let i = 0; i < 200; i += 1) rate.allow(`key-${String(i)}`);
    expect(rate.size).toBe(200);
    clock.advance(60);
    rate.allow('fresh');
    expect(rate.size).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'M1-03 refuses a limit of %s',
    (limitPerMinute) => {
      expect(() => limiter(limitPerMinute)).toThrow(RangeError);
    },
  );
});
