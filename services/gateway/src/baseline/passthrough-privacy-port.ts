import type { IdentityToStore, PrivacyPort, PseudonymizeRequest } from '../tokenizer/privacy-port';

/**
 * The baseline adapter of `PrivacyPort` (gateway spec 8, ADR-0006 no. 6, FR-23): there is no Privacy Service, so the
 * "pseudonym" of a subject is the customer id or the account number itself and the tokenizer passes it on. There is no
 * vault either, so a registration stores nothing and a compensation has nothing to take back. The path around the port
 * (JWT, rate, transaction id, error masking) is the one of proposed. Built through `baselinePrivacyPort`, which refuses
 * any mode but baseline: this adapter carries real identities by design.
 */
export class PassthroughPrivacyPort implements PrivacyPort {
  pseudonymize(request: PseudonymizeRequest): Promise<string> {
    return Promise.resolve(request.subjectId);
  }

  storeIdentity(_identity: IdentityToStore): Promise<void> {
    return Promise.resolve();
  }

  revokeCustomer(_customerId: string): Promise<void> {
    return Promise.resolve();
  }
}
