import type { PrivacyClient } from '../notification/service';

/**
 * The baseline adapter of `PrivacyClient` (ADR-0006 no. 6, N-44): there is no Privacy to ask, and the notification token
 * of this mode is the customer id itself, so it is the domain id too. Built through `baselinePrivacyClient`, which
 * refuses any mode but baseline.
 */
export class BaselinePrivacyClient implements PrivacyClient {
  resolveDomain(notifToken: string): Promise<string> {
    return Promise.resolve(notifToken);
  }
}
