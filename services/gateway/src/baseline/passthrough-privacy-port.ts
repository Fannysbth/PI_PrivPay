import { DomainError, subjectRefShape } from '@privpay/common';
import type { PrivacyPort, PseudonymizeRequest } from '../tokenizer/privacy-port';

/**
 * The baseline adapter of `PrivacyPort` (gateway spec 8, ADR-0006 no. 6, FR-23): there is no Privacy Service, so the
 * "pseudonym" of a subject is the customer id or the account number itself and the tokenizer passes it on. There is no
 * vault either, so a registration stores nothing and a compensation has nothing to take back. The path around the port
 * (JWT, rate, transaction id, error masking) is the one of proposed. Built through `baselinePrivacyPort`, which refuses
 * any mode but baseline: this adapter carries real identities by design.
 */
export class PassthroughPrivacyPort implements PrivacyPort {
  pseudonymize(request: PseudonymizeRequest): Promise<string> {
    // The identity is passed on only in the form of this mode (N-44), as proposed checks the form of the token it gets.
    const shape = subjectRefShape('baseline');
    const form = request.subjectType === 'CUSTOMER' ? shape.customer : shape.account;
    if (!form.test(request.subjectId)) {
      return Promise.reject(new DomainError('VALIDATION_ERROR', 'subject'));
    }
    return Promise.resolve(request.subjectId);
  }

  /** ADR-0019: the same pass-through for each element; one that is malformed fails the lot, as in proposed. */
  async pseudonymizeBatch(requests: readonly PseudonymizeRequest[]): Promise<string[]> {
    return Promise.all(requests.map((request) => this.pseudonymize(request)));
  }

  storeIdentity(): Promise<void> {
    return Promise.resolve();
  }

  revokeCustomer(): Promise<void> {
    return Promise.resolve();
  }
}
