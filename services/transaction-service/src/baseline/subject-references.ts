import type { SubjectReferencePort, SubjectRow } from '../transaction/ports';

/**
 * The baseline adapter of the port (ADR-0006, spec transaction 5 "Mode baseline"): Privacy is not called, Fraud and
 * Notification get the `customer_id` the row holds, and an identity does not expire, so a re-issue changes nothing.
 * Built through `baselineSubjectReferences`, which refuses any mode but baseline.
 */
export class BaselineSubjectReferences implements SubjectReferencePort {
  forFraud(row: SubjectRow): Promise<string> {
    return Promise.resolve(row.customerToken);
  }

  forNotification(row: SubjectRow): Promise<string> {
    return Promise.resolve(row.customerToken);
  }

  reissue(
    row: SubjectRow,
  ): Promise<{ readonly customerToken: string; readonly accountToken: string }> {
    return Promise.resolve({ customerToken: row.customerToken, accountToken: row.accountToken });
  }
}
