import type { PrivacyStatusClient } from '../transaction/ports';

/**
 * The baseline adapter of `PrivacyStatusClient` (ADR-0006 no. 6): there is no Privacy to tell, so there is nothing to
 * send and the call is a success. The row is then marked as told, which keeps the cleaner from repeating a PATCH that
 * has no one to receive it. Built through `baselinePrivacyStatus`, which refuses any mode but baseline.
 */
export class BaselinePrivacyStatus implements PrivacyStatusClient {
  patchStatus(): Promise<void> {
    return Promise.resolve();
  }
}
