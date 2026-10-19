import { FakeClock } from '../src/clock';
import type { DomainError } from '../src/errors';
import { createTokenCache, type IssuedToken } from '../src/token-cache';

const CANARY = 'canary-jwt-eyJhbGciOiJSUzI1NiJ9.canary.signature';

function setup(tokens: (IssuedToken | Error)[]) {
  const clock = new FakeClock('2026-10-05T12:00:00Z');
  let calls = 0;
  const fetchToken = (): Promise<IssuedToken> => {
    calls += 1;
    const next = tokens.shift();
    if (next === undefined) return Promise.reject(new Error('no more tokens'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { clock, cache: createTokenCache({ fetchToken, clock }), calls: () => calls };
}

const expiresIn = (clock: FakeClock, seconds: number): Date => {
  const at = clock.now();
  at.setSeconds(at.getSeconds() + seconds);
  return at;
};

describe('M0-03 the service token is cached until 30 seconds before it expires (NFR-21)', () => {
  it('M0-03 fetches once and serves the cached token while it is fresh', async () => {
    const clock = new FakeClock('2026-10-05T12:00:00Z');
    const { cache, calls } = setup([{ token: 'token-1', expiresAt: expiresIn(clock, 300) }]);
    expect(await cache.get()).toBe('token-1');
    expect(await cache.get()).toBe('token-1');
    expect(calls()).toBe(1);
  });

  it('M0-03 refreshes once the token is within 30 seconds of its expiry', async () => {
    const base = new FakeClock('2026-10-05T12:00:00Z');
    const setupResult = setup([
      { token: 'token-1', expiresAt: expiresIn(base, 300) },
      { token: 'token-2', expiresAt: expiresIn(base, 600) },
    ]);
    expect(await setupResult.cache.get()).toBe('token-1');
    setupResult.clock.advance(269);
    expect(await setupResult.cache.get()).toBe('token-1');
    setupResult.clock.advance(1);
    expect(await setupResult.cache.get()).toBe('token-2');
    expect(setupResult.calls()).toBe(2);
  });

  it('M0-03 makes concurrent callers share one fetch', async () => {
    const base = new FakeClock('2026-10-05T12:00:00Z');
    const { cache, calls } = setup([{ token: 'token-1', expiresAt: expiresIn(base, 300) }]);
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.get()));
    expect(new Set(results)).toEqual(new Set(['token-1']));
    expect(calls()).toBe(1);
  });

  it('M0-03 does not cache a failure and never echoes a token in the error', async () => {
    const base = new FakeClock('2026-10-05T12:00:00Z');
    const { cache, calls } = setup([
      new Error(`identity provider said ${CANARY}`),
      { token: 'token-2', expiresAt: expiresIn(base, 300) },
    ]);
    const error = await cache.get().then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(CANARY);
    expect(await cache.get()).toBe('token-2');
    expect(calls()).toBe(2);
  });

  it('M0-03 hands out a token that expires within the skew but does not cache it', async () => {
    const base = new FakeClock('2026-10-05T12:00:00Z');
    const { cache, calls } = setup([
      { token: 'short-1', expiresAt: expiresIn(base, 10) },
      { token: 'short-2', expiresAt: expiresIn(base, 10) },
    ]);
    expect(await cache.get()).toBe('short-1');
    expect(await cache.get()).toBe('short-2');
    expect(calls()).toBe(2);
  });

  it('M0-03 refuses a token that has already expired', async () => {
    const base = new FakeClock('2026-10-05T12:00:00Z');
    const { cache } = setup([{ token: 'token-1', expiresAt: expiresIn(base, -1) }]);
    const error = await cache.get().then(
      () => undefined,
      (caught: unknown) => caught as DomainError,
    );
    expect(error?.reason).toBe('INTERNAL_ERROR');
  });

  it('M0-03 shares one failure with every concurrent caller', async () => {
    const { cache, calls } = setup([new Error('provider down')]);
    const results = await Promise.allSettled([cache.get(), cache.get(), cache.get()]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(calls()).toBe(1);
  });
});
