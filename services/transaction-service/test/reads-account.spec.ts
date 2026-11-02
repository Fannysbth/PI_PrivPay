import { buildCanary } from '../../../tests/pii-scan/canary';
import { TransactionReads } from '../src/transaction/reads';
import type { TransactionDetail } from '../src/transaction/repository';

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

const reads = (discloseAccount: boolean, found = true) =>
  new TransactionReads({
    discloseAccount,
    repository: {
      listCompleted: () => Promise.resolve([]),
      listCompletedWithIdentity: () => Promise.resolve([]),
      findDetail: () => Promise.resolve(found ? DETAIL : undefined),
      // One read that holds the account next to the rest, so the answer cannot tear between two reads.
      findDetailWithAccount: () =>
        Promise.resolve(found ? { ...DETAIL, accountRef: ACCOUNT_NUMBER } : undefined),
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

// G5, Tabel IV: the identity reads. The values are invented.
const canary = buildCanary(54);
const IDENTITY = { customer_id: canary.customer_id, nik: canary.nik, nama: canary.nama };
const withIdentity = (discloseAccount: boolean) =>
  new TransactionReads({
    discloseAccount,
    repository: {
      listCompleted: () =>
        Promise.resolve([
          {
            completedText: '2026-10-23T08:00:01.000000Z',
            item: {
              transaction_id: 'TX-10001',
              amount: 35_000,
              completed_at: DETAIL.completed_at ?? '',
            },
          },
        ]),
      listCompletedWithIdentity: () =>
        Promise.resolve([
          {
            completedText: '2026-10-23T08:00:01.000000Z',
            item: {
              transaction_id: 'TX-10001',
              amount: 35_000,
              completed_at: DETAIL.completed_at ?? '',
              ...IDENTITY,
              account_number: ACCOUNT_NUMBER,
            },
          },
        ]),
      findDetail: () => Promise.resolve(DETAIL),
      findDetailWithAccount: () =>
        Promise.resolve({
          ...DETAIL,
          accountRef: ACCOUNT_NUMBER,
          customerRef: IDENTITY.customer_id,
          holderNik: IDENTITY.nik,
          holderNama: IDENTITY.nama,
        }),
    },
  });

describe('G5 the identity Reconciliation reads in baseline', () => {
  it('G5 with the disclosure the completed item and the detail carry customer_id, nik, nama and account_number', async () => {
    const page = await withIdentity(true).completedOn('2026-10-23', { limit: 10 });
    expect(page.items).toEqual([
      {
        transaction_id: 'TX-10001',
        amount: 35_000,
        completed_at: DETAIL.completed_at,
        ...IDENTITY,
        account_number: ACCOUNT_NUMBER,
      },
    ]);
    expect(await withIdentity(true).detail('TX-10001')).toEqual({
      ...DETAIL,
      ...IDENTITY,
      account_number: ACCOUNT_NUMBER,
    });
  });

  it('G5 without the disclosure (proposed) the list is the three fields and the detail has none of them', async () => {
    const page = await withIdentity(false).completedOn('2026-10-23', { limit: 10 });
    expect(Object.keys(page.items[0] ?? {})).toEqual(['transaction_id', 'amount', 'completed_at']);
    expect(await withIdentity(false).detail('TX-10001')).toEqual(DETAIL);
  });
});
