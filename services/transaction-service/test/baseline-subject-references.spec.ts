import { baselineSubjectReferences } from '../src/baseline';
import type { SubjectRow } from '../src/transaction';

// Seam: the baseline adapter of SubjectReferencePort (ADR-0006, spec transaction 5 "Mode baseline"). The identity goes to
// the neighbours as it is, and nothing is called: the adapter has no client to call with.
const row: SubjectRow = {
  transactionId: 'TX-5001',
  customerToken: ['CUST', '000101'].join('-'),
  accountToken: '1234567801',
};

describe('M5-01 FR-23 the baseline SubjectReferencePort', () => {
  it('M5-01 FR-23 hands the customer to Fraud and to Notification as the identity it was given', async () => {
    const subjects = baselineSubjectReferences('baseline');
    expect(await subjects.forFraud(row)).toBe(row.customerToken);
    expect(await subjects.forNotification(row)).toBe(row.customerToken);
  });

  it('M5-01 FR-23 a re-issue changes nothing, since an identity does not expire', async () => {
    const issued = await baselineSubjectReferences('baseline').reissue(row);
    expect(issued).toEqual({ customerToken: row.customerToken, accountToken: row.accountToken });
  });

  it('M5-01 ADR-0006 it refuses to be built in the proposed mode, since it carries real identities', () => {
    expect(() => baselineSubjectReferences('proposed')).toThrow(/PRIVACY_MODE=baseline/);
  });
});
