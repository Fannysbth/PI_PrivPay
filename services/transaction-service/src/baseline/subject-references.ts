import type { FraudAttributes, SubjectReferencePort, SubjectRow } from '../transaction/ports';

/**
 * The baseline adapter of the port (ADR-0006, spec transaction 5 "Mode baseline"): Privacy is not called, Fraud and
 * Notification get the `customer_id` the row holds, and an identity does not expire, so a re-issue changes nothing.
 * Built through `baselineSubjectReferences`, which refuses any mode but baseline.
 */
export class BaselineSubjectReferences implements SubjectReferencePort {
  forFraud(row: SubjectRow): Promise<string> {
    return Promise.resolve(row.customerSubjectRef);
  }

  forNotification(row: SubjectRow): Promise<string> {
    return Promise.resolve(row.customerSubjectRef);
  }

  /** G3, Tabel IV: Fraud gets NIK, name and account number besides the customer id; absent ones are left out. */
  identityForFraud(row: SubjectRow): Promise<FraudAttributes | undefined> {
    return Promise.resolve({
      ...(row.clientIdentity?.nik === undefined ? {} : { nik: row.clientIdentity.nik }),
      ...(row.clientIdentity?.nama === undefined ? {} : { nama: row.clientIdentity.nama }),
      accountNumber: row.accountSubjectRef,
    });
  }

  reissue(
    row: SubjectRow,
  ): Promise<{ readonly customerSubjectRef: string; readonly accountSubjectRef: string }> {
    return Promise.resolve({
      customerSubjectRef: row.customerSubjectRef,
      accountSubjectRef: row.accountSubjectRef,
    });
  }
}
