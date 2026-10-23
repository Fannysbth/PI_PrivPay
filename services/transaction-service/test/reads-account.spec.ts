import { TransactionReads } from '../src/transaction/reads';
import type { StoredTransaction, TransactionDetail } from '../src/transaction/repository';

// Seam: TransactionReads.detail (spec transaction 3.4) with a repository that answers from memory. N-46: in baseline
// Reconciliation has no Privacy to turn a transaction into an account, so the detail it reads carries the account number;
// in proposed it never does. The account number is invented.
const ACCOUNT_NUMBER = '1234567801';
const DETAIL: TransactionDetail = {
  transaction_id: 'TX-10001',
  amount: 35_000,
  status: 'COMPLETED',
  created_at: '2026-10-23T08:00:00.000Z',
  completed_at: '2026-10-23T08:00:01.000Z',
};
const STORED = {
  transactionId: 'TX-10001',
  customerSubjectRef: 'CUST-000101',
  accountSubjectRef: ACCOUNT_NUMBER,
  merchantId: 'MRC-001',
  amount: 35_000,
  geohash: 'qqgu4',
  status: 'COMPLETED',
} as unknown as StoredTransaction;

const reads = (discloseAccount: boolean, found = true) =>
  new TransactionReads({
    discloseAccount,
    repository: {
      listCompleted: () => Promise.resolve([]),
      findDetail: () => Promise.resolve(found ? DETAIL : undefined),
      findById: () => Promise.resolve(found ? STORED : undefined),
    },
  });

describe('M5-02 N-44 N-46 the detail Reconciliation reads', () => {
  it('M5-02 N-46 without the disclosure the detail is what it always was: no account, no token', async () => {
    expect(await reads(false).detail('TX-10001')).toEqual(DETAIL);
  });

  it('M5-02 N-46 with the disclosure (baseline) the detail also carries account_number', async () => {
    expect(await reads(true).detail('TX-10001')).toEqual({
      ...DETAIL,
      account_number: ACCOUNT_NUMBER,
    });
  });

  it('M5-02 N-46 a transaction that is not there is still TRANSACTION_NOT_FOUND in both', async () => {
    for (const disclose of [false, true]) {
      await expect(reads(disclose, false).detail('TX-10001')).rejects.toMatchObject({
        reason: 'TRANSACTION_NOT_FOUND',
      });
    }
  });
});
