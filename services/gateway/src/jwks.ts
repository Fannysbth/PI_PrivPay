import { createPublicKey, type KeyObject } from 'node:crypto';
import { DomainError, type Clock } from '@privpay/common';
import { z } from 'zod';

/** Where the issuer's public keys come from; the HTTP adapter is in the module, a fake in the tests. */
export interface JwksSource {
  fetch(): Promise<unknown>;
}

export interface JwksKeysOptions {
  readonly source: JwksSource;
  readonly clock: Clock;
  /** Minimum time between two refreshes caused by a key id nobody knows. */
  readonly cooldownSeconds: number;
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
 * The issuer's public keys by key id (FR-01). A token naming a key id that is not known makes the keys reload, but not
 * more than once per cooldown, so a flood of random key ids cannot turn into a flood of requests to the IdP. A JWKS
 * with anything wrong in it replaces nothing; the keys already held stay valid.
 */
export class JwksKeys {
  private keys = new Map<string, KeyObject>();
  private loaded = false;
  private inFlight: Promise<void> | undefined;
  private lastMissRefresh: number | undefined;
  private lastFailure: number | undefined;

  constructor(private readonly options: JwksKeysOptions) {}

  resolveKey(kid: string | undefined): KeyObject | undefined {
    return kid === undefined ? undefined : this.keys.get(kid);
  }

  /** Makes sure `resolveKey(kid)` has had its chance: loads the keys first and refreshes for an unknown id. */
  async ensure(kid: string | undefined): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    if (this.loaded && (kid === undefined || this.keys.has(kid))) return;

    const now = this.options.clock.now().getTime();
    const cooldownMs = this.options.cooldownSeconds * 1000;
    if (this.lastFailure !== undefined && now - this.lastFailure < cooldownMs) {
      throw unavailable('cooldown');
    }
    if (this.loaded) {
      if (this.lastMissRefresh !== undefined && now - this.lastMissRefresh < cooldownMs) return;
      this.lastMissRefresh = now;
    }
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<void> {
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
      this.lastFailure = undefined;
    } catch (error) {
      this.lastFailure = this.options.clock.now().getTime();
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
