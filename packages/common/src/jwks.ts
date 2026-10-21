import { createPublicKey, type KeyObject } from 'node:crypto';
import type { Clock } from './clock';
import { DomainError } from './errors';
import type { HttpClient } from './http';
import { z } from 'zod';

/**
 * What a service reads to trust the issuer (FR-01). Shared so the gateway and the privacy service cannot drift apart
 * on how long a withdrawn key stays trusted.
 */
export const idpConfigShape = {
  // Addresses of the other processes come from configuration only (API7): the client never names a URL.
  IDP_URL: z.url({ protocol: /^https?$/, hostname: z.regexes.hostname }),
  IDP_ISSUER: z.string().min(1).max(128).default('privpay-dev-idp'),
  /** Minimum seconds between two reloads of the issuer's keys caused by an unknown key id. */
  JWKS_REFRESH_COOLDOWN_SECONDS: z.coerce.number().int().min(1).default(30),
  /** Keys older than this are reloaded, so a key the IdP withdrew stops being trusted (FR-01). */
  JWKS_MAX_AGE_SECONDS: z.coerce.number().int().min(30).default(300),
};

/** The IdP's JWKS over the shared HTTP client; `http` must know a base URL named `idp`. */
export function idpJwksSource(http: HttpClient): JwksSource {
  return {
    fetch: async () => {
      const answer = await http.request({
        service: 'idp',
        method: 'GET',
        path: '/.well-known/jwks.json',
        idempotent: true,
      });
      if (answer.status !== 200) throw new DomainError('SERVICE_UNAVAILABLE', 'jwks');
      return answer.body;
    },
  };
}

/** Where the issuer's public keys come from; the HTTP adapter is in the module, a fake in the tests. */
export interface JwksSource {
  fetch(): Promise<unknown>;
}

export interface JwksKeysOptions {
  readonly source: JwksSource;
  readonly clock: Clock;
  /** Minimum time between two reloads caused by a key id nobody knows. */
  readonly cooldownSeconds: number;
  /** Keys older than this are reloaded even for a known key id, so a key the issuer withdrew stops being trusted. */
  readonly maxAgeSeconds: number;
}

// Strict on purpose: a key with a private member, another type or another algorithm is not something to import.
const jwkSchema = z.strictObject({
  kty: z.literal('RSA'),
  n: z.string().min(1),
  e: z.string().min(1),
  kid: z.string().min(1).max(128),
  alg: z.literal('RS256').optional(),
  use: z.literal('sig').optional(),
});
const jwksSchema = z.strictObject({ keys: z.array(jwkSchema).min(1).max(16) });

const unavailable = (category: string): DomainError =>
  new DomainError('SERVICE_UNAVAILABLE', category);

/**
 * The issuer's public keys by key id (FR-01). Three things make the keys load again: they were never loaded, a token
 * names a key id nobody knows (at most once per cooldown, so a flood of random ids cannot become a flood of requests
 * to the IdP), and they have grown older than the maximum age (so a withdrawn key does not stay trusted for as long
 * as the process lives). Keys that are too old and cannot be renewed are dropped: the gateway fails closed. A JWKS with
 * anything wrong in it replaces nothing.
 */
export class JwksKeys {
  private keys = new Map<string, KeyObject>();
  private loaded = false;
  private loadedAt = 0;
  private inFlight: Promise<void> | undefined;
  private lastMissRefresh: number | undefined;
  private lastFailure: number | undefined;

  constructor(private readonly options: JwksKeysOptions) {}

  resolveKey(kid: string | undefined): KeyObject | undefined {
    return kid === undefined ? undefined : this.keys.get(kid);
  }

  /** Makes sure `resolveKey(kid)` has had its chance: loads, reloads for an unknown id, and renews old keys. */
  async ensure(kid: string | undefined): Promise<void> {
    const now = this.options.clock.now().getTime();
    const stale = this.loaded && now - this.loadedAt >= this.options.maxAgeSeconds * 1000;
    // A key we hold and trust is answered from memory, whatever reload is under way: a slow or failing IdP, or a flood
    // of made-up key ids, must not hold up or fail the callers whose keys are fine.
    if (this.loaded && !stale && (kid === undefined || this.keys.has(kid))) return;
    if (this.inFlight !== undefined) return this.inFlight;

    const cooldownMs = this.options.cooldownSeconds * 1000;
    if (this.lastFailure !== undefined && now - this.lastFailure < cooldownMs) {
      throw unavailable('cooldown');
    }
    if (this.loaded && !stale) {
      if (this.lastMissRefresh !== undefined && now - this.lastMissRefresh < cooldownMs) return;
      this.lastMissRefresh = now;
    }
    this.inFlight = this.refresh(stale).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(wasStale: boolean): Promise<void> {
    try {
      let body: unknown;
      try {
        body = await this.options.source.fetch();
      } catch {
        // The error text could carry the IdP's address; callers only learn that the IdP is unavailable.
        throw unavailable('jwks_unavailable');
      }
      const parsed = jwksSchema.safeParse(body);
      if (!parsed.success) throw unavailable('jwks_invalid');
      const next = new Map<string, KeyObject>();
      for (const jwk of parsed.data.keys) {
        try {
          next.set(
            jwk.kid,
            createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }),
          );
        } catch {
          throw unavailable('jwks_invalid');
        }
      }
      this.keys = next;
      this.loaded = true;
      this.loadedAt = this.options.clock.now().getTime();
      this.lastFailure = undefined;
    } catch (error) {
      this.lastFailure = this.options.clock.now().getTime();
      if (wasStale) {
        // Past the maximum age and not renewable: trust nothing until the IdP answers again.
        this.keys = new Map();
        this.loaded = false;
      }
      throw error;
    }
  }
}

/**
 * The `kid` a token claims, read without trusting the token: it only chooses which key to try (and whether to reload
 * the keys). The signature is checked afterwards, so a made-up id gains nothing.
 */
export function unverifiedKid(token: string): string | undefined {
  const header = token.split('.')[0];
  if (header === undefined || header.length > 512) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const kid =
      typeof parsed === 'object' && parsed !== null ? (parsed as { kid?: unknown }).kid : undefined;
    return typeof kid === 'string' && kid.length <= 128 ? kid : undefined;
  } catch {
    return undefined;
  }
}
