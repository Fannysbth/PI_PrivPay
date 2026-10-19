import type { Clock } from './clock';
import { DomainError } from './errors';

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface TokenCacheOptions {
  readonly fetchToken: () => Promise<IssuedToken>;
  readonly clock: Clock;
  /** Seconds before `exp` at which the cached token is considered stale (NFR-21). */
  readonly skewSeconds?: number;
}

export interface TokenCache {
  get(): Promise<string>;
}

/**
 * Caches a service token until shortly before it expires. Concurrent callers share one fetch, so a burst of
 * requests right after expiry does not hammer the identity provider.
 */
export function createTokenCache(options: TokenCacheOptions): TokenCache {
  const skewMs = (options.skewSeconds ?? 30) * 1000;
  let cached: IssuedToken | undefined;
  let inFlight: Promise<string> | undefined;

  const isFresh = (issued: IssuedToken): boolean =>
    issued.expiresAt.getTime() - skewMs > options.clock.now().getTime();

  async function refresh(): Promise<string> {
    let issued: IssuedToken;
    try {
      issued = await options.fetchToken();
    } catch {
      // The provider's message could quote a token; callers only learn that the provider is unavailable.
      throw new DomainError('SERVICE_UNAVAILABLE');
    }
    if (issued.expiresAt.getTime() <= options.clock.now().getTime()) {
      throw new DomainError('INTERNAL_ERROR', 'token_already_expired');
    }
    // A token that lives less than the skew is still handed out; get() treats it as stale and fetches again.
    cached = issued;
    return issued.token;
  }

  return {
    get(): Promise<string> {
      if (cached !== undefined && isFresh(cached)) return Promise.resolve(cached.token);
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
