import { FakeClock } from '../src/clock';
import { BoundedTtlCache, loadTokenCacheConfig } from '../src/ttl-cache';

const START = '2026-11-12T00:00:00Z';

function make(over: { ttlSeconds?: number; maxEntries?: number } = {}) {
  const clock = new FakeClock(START);
  const cache = new BoundedTtlCache<string>({
    clock,
    ttlSeconds: over.ttlSeconds ?? 5,
    maxEntries: over.maxEntries ?? 100,
  });
  return { clock, cache };
}

describe('ADR-0020 BoundedTtlCache', () => {
  it('ADR-0020 returns a stored value until T seconds have passed, then forgets it', () => {
    const { clock, cache } = make({ ttlSeconds: 5 });
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
    clock.advance(4.999);
    expect(cache.get('k')).toBe('v');
    clock.advance(0.001);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('ADR-0020 an entry lives min(T, remaining life of the token): a shorter token life wins', () => {
    const { clock, cache } = make({ ttlSeconds: 30 });
    cache.set('short', 'v', 2);
    clock.advance(2);
    expect(cache.get('short')).toBeUndefined();
  });

  it('ADR-0020 a longer token life never stretches the entry past T', () => {
    const { clock, cache } = make({ ttlSeconds: 5 });
    cache.set('long', 'v', 3600);
    clock.advance(5);
    expect(cache.get('long')).toBeUndefined();
  });

  it('ADR-0020 a token with no life left is not stored at all', () => {
    const { cache } = make();
    cache.set('gone', 'v', 0);
    cache.set('negative', 'v', -3);
    expect(cache.size).toBe(0);
    expect(cache.get('gone')).toBeUndefined();
  });

  it('ADR-0020 T = 0 switches the cache off: nothing is ever stored', () => {
    const { cache } = make({ ttlSeconds: 0 });
    cache.set('k', 'v');
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('ADR-0020 the number of entries is bounded and the oldest entry goes first', () => {
    const { cache } = make({ maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
  });

  it('ADR-0020 expired entries are dropped before a live one is pushed out', () => {
    const { clock, cache } = make({ maxEntries: 2, ttlSeconds: 5 });
    cache.set('old', '1');
    clock.advance(3);
    cache.set('live', '2');
    clock.advance(2.5); // old is 5.5 seconds old, live 2.5
    cache.set('new', '3');
    expect(cache.get('live')).toBe('2');
    expect(cache.get('new')).toBe('3');
    expect(cache.size).toBe(2);
  });

  it('ADR-0020 setting a key again restarts its clock and does not grow the cache', () => {
    const { clock, cache } = make({ ttlSeconds: 5, maxEntries: 2 });
    cache.set('k', 'v1');
    clock.advance(4);
    cache.set('k', 'v2');
    clock.advance(4);
    expect(cache.get('k')).toBe('v2');
    expect(cache.size).toBe(1);
  });

  it('ADR-0020 delete and clear forget at once', () => {
    const { cache } = make();
    cache.set('a', '1');
    cache.set('b', '2');
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('ADR-0020 time only comes from the injected clock (UTC, no real sleep)', () => {
    const { clock, cache } = make({ ttlSeconds: 5 });
    cache.set('k', 'v');
    jest.useFakeTimers();
    try {
      jest.advanceTimersByTime(60_000); // wall time moves, the injected clock does not
      expect(cache.get('k')).toBe('v');
    } finally {
      jest.useRealTimers();
    }
    clock.advance(5);
    expect(cache.get('k')).toBeUndefined();
  });

  it('ADR-0020 rejects a nonsense T or size when it is built', () => {
    const clock = new FakeClock(START);
    for (const ttlSeconds of [-1, 1.5, Number.NaN, 301])
      expect(() => new BoundedTtlCache({ clock, ttlSeconds, maxEntries: 10 })).toThrow(RangeError);
    for (const maxEntries of [0, -1, 2.5, Number.NaN])
      expect(() => new BoundedTtlCache({ clock, ttlSeconds: 5, maxEntries })).toThrow(RangeError);
  });
});

describe('ADR-0020 token cache settings from the environment', () => {
  it('ADR-0020 defaults to T = 5 seconds and a bounded size when nothing is set', () => {
    expect(loadTokenCacheConfig({})).toEqual({ ttlSeconds: 5, maxEntries: 1000 });
  });

  it('ADR-0020 T can be changed from TOKEN_CACHE_TTL_SECONDS (30 is the sensitivity variant, 0 is off)', () => {
    expect(loadTokenCacheConfig({ TOKEN_CACHE_TTL_SECONDS: '30' }).ttlSeconds).toBe(30);
    expect(loadTokenCacheConfig({ TOKEN_CACHE_TTL_SECONDS: '0' }).ttlSeconds).toBe(0);
    expect(loadTokenCacheConfig({ TOKEN_CACHE_MAX_ENTRIES: '50' }).maxEntries).toBe(50);
  });

  it('ADR-0020 fails fast on a value that is not a whole number in range', () => {
    for (const value of ['-1', '1.5', 'abc', '301', ' '])
      expect(() => loadTokenCacheConfig({ TOKEN_CACHE_TTL_SECONDS: value })).toThrow(
        /TOKEN_CACHE_TTL_SECONDS/,
      );
    for (const value of ['0', '-5', 'x', '1.5', '1000001'])
      expect(() => loadTokenCacheConfig({ TOKEN_CACHE_MAX_ENTRIES: value })).toThrow(
        /TOKEN_CACHE_MAX_ENTRIES/,
      );
  });
});
