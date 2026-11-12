import { z } from 'zod';
import type { Clock } from './clock';
import { loadConfig, type EnvSource } from './config';

/** ADR-0020: the upper bound of T. Five minutes is the longest window the project is willing to defend. */
export const MAX_TOKEN_CACHE_TTL_SECONDS = 300;
const MAX_ENTRIES_LIMIT = 1_000_000;

const wholeNumber = (min: number, max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

/**
 * ADR-0020: the settings of the bounded token cache. T comes from the environment so it can be changed without touching
 * code (5 seconds by default, 30 as the sensitivity variant, 0 switches the cache off). A value that is not a whole
 * number in range stops the start (fail fast).
 */
export const tokenCacheConfigShape = {
  TOKEN_CACHE_TTL_SECONDS: wholeNumber(0, MAX_TOKEN_CACHE_TTL_SECONDS).default(5),
  TOKEN_CACHE_MAX_ENTRIES: wholeNumber(1, MAX_ENTRIES_LIMIT).default(1000),
};

export interface TokenCacheSettings {
  readonly ttlSeconds: number;
  readonly maxEntries: number;
}

export function tokenCacheSettings(config: {
  readonly TOKEN_CACHE_TTL_SECONDS: number;
  readonly TOKEN_CACHE_MAX_ENTRIES: number;
}): TokenCacheSettings {
  return { ttlSeconds: config.TOKEN_CACHE_TTL_SECONDS, maxEntries: config.TOKEN_CACHE_MAX_ENTRIES };
}

export function loadTokenCacheConfig(env: EnvSource): TokenCacheSettings {
  return tokenCacheSettings(loadConfig(z.object(tokenCacheConfigShape), env));
}

export interface BoundedTtlCacheOptions {
  readonly clock: Clock;
  /** T in whole seconds; 0 = off. */
  readonly ttlSeconds: number;
  readonly maxEntries: number;
}

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

/**
 * ADR-0020: memory only, never written to disk or log. An entry lives min(T, the remaining life of the token it
 * stands for), so it can never outlive the token. The number of entries is bounded; when full, expired entries go
 * first and then the oldest. Time comes from the injected clock (NFR-20).
 */
export class BoundedTtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly ttlMs: number;

  constructor(private readonly options: BoundedTtlCacheOptions) {
    const { ttlSeconds, maxEntries } = options;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 0 ||
      ttlSeconds > MAX_TOKEN_CACHE_TTL_SECONDS
    ) {
      throw new RangeError('ttlSeconds must be a whole number from 0 to 300');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive whole number');
    }
    this.ttlMs = ttlSeconds * 1000;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.options.clock.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** `lifetimeSeconds`: what is left of the token itself, when it is known. */
  set(key: string, value: V, lifetimeSeconds?: number): void {
    if (this.ttlMs === 0) return;
    const now = this.options.clock.now().getTime();
    const lifeMs =
      lifetimeSeconds === undefined ? this.ttlMs : Math.min(this.ttlMs, lifetimeSeconds * 1000);
    if (!(lifeMs > 0)) {
      this.entries.delete(key);
      return;
    }
    // A key that is set again restarts its clock and moves to the newest position.
    this.entries.delete(key);
    if (this.entries.size >= this.options.maxEntries) this.makeRoom(now);
    this.entries.set(key, { value, expiresAt: now + lifeMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private makeRoom(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }
}
