import type { BoundedTtlCache } from '@privpay/common';
import type { PrivacyClient } from './service';

/**
 * ADR-0020: the answer of resolve-domain (P4 to P5) is kept for T seconds at most, keyed by the P4 token. The answer does not
 * say when the domain token ends, so T alone limits the entry (ADR-0021: a revocation or an end of life is seen after T
 * seconds at the latest). Only a success is kept; a refusal or an outage goes to the caller and nothing is stored, so with
 * a cold cache Privacy being down is still a failure at once (invariant 8).
 */
export class CachedPrivacyClient implements PrivacyClient {
  constructor(
    private readonly inner: PrivacyClient,
    private readonly cache: BoundedTtlCache<string>,
  ) {}

  async resolveDomain(notifToken: string): Promise<string> {
    const hit = this.cache.get(notifToken);
    if (hit !== undefined) return hit;
    const domain = await this.inner.resolveDomain(notifToken);
    this.cache.set(notifToken, domain);
    return domain;
  }
}
