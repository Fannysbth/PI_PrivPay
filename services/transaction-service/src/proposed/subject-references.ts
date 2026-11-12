import type { BoundedTtlCache, Clock } from '@privpay/common';
import type { ExchangeRequest, HttpPrivacyClient } from '../transaction/clients';
import type { FraudAttributes, SubjectReferencePort, SubjectRow } from '../transaction/ports';

/**
 * The proposed adapter of the port (ADR-0006): customer tokens go to Fraud (P3) and Notification (P4) by exchange, and
 * both tokens of a transaction are issued again together when one expired (spec transaction 5, step 5).
 */
export class ProposedSubjectReferences implements SubjectReferencePort {
  /**
   * `exchangeCache` (ADR-0020, optional): the answer of an exchange is kept for at most T seconds. The key is the source
   * token with the target and the purpose, not the transaction id: the same person's token gives the same answer for
   * the next payment. Only a success with a known end is kept; a failure or an EXPIRED answer is never kept, so the
   * re-issue path (TF-04) still sees it. Nothing is kept for a cold start, so Privacy being down is still 503 at once
   * (ADR-0021).
   */
  constructor(
    private readonly privacy: Pick<HttpPrivacyClient, 'exchangeWithExpiry' | 'reIssue'>,
    private readonly exchangeCache?: {
      readonly cache: BoundedTtlCache<string>;
      readonly clock: Clock;
    },
  ) {}

  private async exchange(request: ExchangeRequest): Promise<string> {
    const cached = this.exchangeCache;
    if (cached === undefined) return (await this.privacy.exchangeWithExpiry(request)).pseudonym;
    const key = `${request.sourcePseudonym}|${request.targetService}|${request.purpose}`;
    const hit = cached.cache.get(key);
    if (hit !== undefined) return hit;
    const result = await this.privacy.exchangeWithExpiry(request);
    if (result.expiresAt !== undefined) {
      const remaining = (result.expiresAt.getTime() - cached.clock.now().getTime()) / 1000;
      cached.cache.set(key, result.pseudonym, remaining);
    }
    return result.pseudonym;
  }

  forFraud(row: SubjectRow): Promise<string> {
    return this.exchange({
      sourcePseudonym: row.customerSubjectRef,
      targetService: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      transactionId: row.transactionId,
    });
  }

  forNotification(row: SubjectRow): Promise<string> {
    return this.exchange({
      sourcePseudonym: row.customerSubjectRef,
      targetService: 'NOTIFICATION',
      purpose: 'NOTIFICATION',
      transactionId: row.transactionId,
    });
  }

  /** G3: Fraud receives the token and nothing else. */
  identityForFraud(_row: SubjectRow): Promise<FraudAttributes | undefined> {
    return Promise.resolve(undefined);
  }

  async reissue(row: SubjectRow) {
    const customerSubjectRef = await this.privacy.reIssue(
      row.customerSubjectRef,
      row.transactionId,
    );
    const accountSubjectRef = await this.privacy.reIssue(row.accountSubjectRef, row.transactionId);
    return { customerSubjectRef, accountSubjectRef };
  }
}
