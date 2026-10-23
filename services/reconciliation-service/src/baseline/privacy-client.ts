import { DomainError } from '@privpay/common';
import type { DisclosedAttributes, PrivacyClient, TransactionClient } from '../reconciliation';

/**
 * The baseline adapter of `PrivacyClient` (ADR-0006 no. 6, N-44): there is no Privacy, so the account of a transaction
 * is the number Transaction names for it. A transaction Transaction does not know is counted unmatched, like one Privacy
 * has no token for. The audit routes are the privacy layer (TK-xx only apply to proposed): without Privacy they cannot
 * give a token or open anything, and they say so instead of pretending. Built through `baselinePrivacyClient`, which
 * refuses any mode but baseline.
 */
export class BaselinePrivacyClient implements PrivacyClient {
  constructor(private readonly transactions: Pick<TransactionClient, 'byId'>) {}

  async accountSubjectRef(transactionId: string): Promise<string | null> {
    try {
      return (await this.transactions.byId(transactionId)).accountRef ?? null;
    } catch (error) {
      if (error instanceof DomainError && error.reason === 'TRANSACTION_NOT_FOUND') return null;
      throw error;
    }
  }

  auditToken(): Promise<string> {
    return Promise.reject(new DomainError('SERVICE_UNAVAILABLE', 'baseline_no_privacy'));
  }

  open(): Promise<DisclosedAttributes> {
    return Promise.reject(new DomainError('SERVICE_UNAVAILABLE', 'baseline_no_privacy'));
  }
}
