import { HttpPrivacyClient } from '../transaction/clients';
import type { SubjectReferencePort, SubjectRow } from '../transaction/ports';

/**
 * The proposed adapter of the port (ADR-0006): customer tokens go to Fraud (P3) and Notification (P4) by exchange, and
 * both tokens of a transaction are issued again together when one expired (spec transaction 5, step 5).
 */
export class ProposedSubjectReferences implements SubjectReferencePort {
  constructor(private readonly privacy: HttpPrivacyClient) {}

  forFraud(row: SubjectRow): Promise<string> {
    return this.privacy.exchange({
      sourcePseudonym: row.customerSubjectRef,
      targetService: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      transactionId: row.transactionId,
    });
  }

  forNotification(row: SubjectRow): Promise<string> {
    return this.privacy.exchange({
      sourcePseudonym: row.customerSubjectRef,
      targetService: 'NOTIFICATION',
      purpose: 'NOTIFICATION',
      transactionId: row.transactionId,
    });
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
