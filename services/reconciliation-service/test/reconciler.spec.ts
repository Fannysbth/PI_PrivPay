import { match, type ReconItem, type ReconTransaction } from '../src/reconciliation/reconciler';

// Seam: the pure matching of spec reconciliation 3.2 step 3 and 4 (D4), no I/O. Every token is invented. The data of
// PRD 16: TX-10001 (35.000) and TX-10003 (1.500.000) are COMPLETED, TX-10002 is HELD and is never given to the matcher.
const A1 = 'PSEU-B80D2C4F';
const A2 = 'PSEU-71D92C0E';
const A3 = 'PSEU-5A83F0B7';

const tx = (
  transactionId: string,
  amount: number,
  accountSubjectRef: string | null,
): ReconTransaction => ({
  transactionId,
  amount,
  accountSubjectRef,
});
const item = (
  id: string,
  accountPseudonym: string,
  amount: number,
  bankReference: string,
): ReconItem => ({
  id,
  accountPseudonym,
  amount,
  bankReference,
});

describe('M4-06 TF-05 FR-41 the matching of a day', () => {
  it('M4-06 TF-05 two items that fit the two transactions are MATCHED with nothing left over', () => {
    const result = match(
      [tx('TX-10001', 35_000, A1), tx('TX-10003', 1_500_000, A3)],
      [item('i1', A1, 35_000, 'BNK-1'), item('i2', A3, 1_500_000, 'BNK-2')],
    );
    expect(result).toEqual({
      pairs: [
        { transactionId: 'TX-10001', itemId: 'i1' },
        { transactionId: 'TX-10003', itemId: 'i2' },
      ],
      unmatchedItems: [],
      unmatchedTransactions: [],
      status: 'MATCHED',
    });
  });

  it('M4-06 TF-16 an item without a transaction makes the day PARTIAL and is named', () => {
    const result = match(
      [tx('TX-10001', 35_000, A1)],
      [item('i1', A1, 35_000, 'BNK-1'), item('i2', A2, 99_000, 'BNK-2')],
    );
    expect(result.status).toBe('PARTIAL');
    expect(result.pairs).toEqual([{ transactionId: 'TX-10001', itemId: 'i1' }]);
    expect(result.unmatchedItems).toEqual(['i2']);
    expect(result.unmatchedTransactions).toEqual([]);
  });

  it('M4-06 TF-16 a transaction without an item makes the day PARTIAL and is named', () => {
    const result = match(
      [tx('TX-10001', 35_000, A1), tx('TX-10003', 1_500_000, A3)],
      [item('i1', A1, 35_000, 'BNK-1')],
    );
    expect(result.status).toBe('PARTIAL');
    expect(result.unmatchedTransactions).toEqual(['TX-10003']);
  });

  it('M4-06 K-22 when nothing fits and something exists the day is MISMATCHED', () => {
    const result = match(
      [tx('TX-10001', 35_000, A1)],
      [item('i1', A1, 36_000, 'BNK-1'), item('i2', A2, 35_000, 'BNK-2')],
    );
    expect(result.status).toBe('MISMATCHED');
    expect(result.pairs).toEqual([]);
  });

  it('M4-06 K-22 a day with no item and no transaction has nothing unmatched and is MATCHED', () => {
    expect(match([], [])).toMatchObject({ status: 'MATCHED', pairs: [] });
  });

  it('M4-06 K-22 a day with transactions and no report at all is MISMATCHED', () => {
    expect(match([tx('TX-10001', 35_000, A1)], []).status).toBe('MISMATCHED');
  });

  it('M4-06 FR-41 the same account and amount twice pair one to one, not many to one', () => {
    const result = match(
      [tx('TX-10001', 35_000, A1), tx('TX-10002', 35_000, A1)],
      [item('i1', A1, 35_000, 'BNK-1')],
    );
    expect(result.pairs).toEqual([{ transactionId: 'TX-10001', itemId: 'i1' }]);
    expect(result.unmatchedTransactions).toEqual(['TX-10002']);
    expect(result.status).toBe('PARTIAL');
  });

  it('M4-06 FR-41 the same amount on another account is not a match', () => {
    const result = match([tx('TX-10001', 35_000, A1)], [item('i1', A2, 35_000, 'BNK-1')]);
    expect(result.pairs).toEqual([]);
  });

  it('M4-06 TF-05 a transaction whose account token Privacy no longer has is unmatched and the rest still pair', () => {
    const result = match(
      [tx('TX-10001', 35_000, null), tx('TX-10003', 1_500_000, A3)],
      [item('i1', A1, 35_000, 'BNK-1'), item('i2', A3, 1_500_000, 'BNK-2')],
    );
    expect(result.pairs).toEqual([{ transactionId: 'TX-10003', itemId: 'i2' }]);
    expect(result.unmatchedTransactions).toEqual(['TX-10001']);
    expect(result.unmatchedItems).toEqual(['i1']);
    expect(result.status).toBe('PARTIAL');
  });

  it('M4-06 FR-41 the pairing does not depend on the order the inputs arrive in', () => {
    const transactions = [tx('TX-10001', 35_000, A1), tx('TX-10002', 35_000, A1)];
    const items = [item('i1', A1, 35_000, 'BNK-1'), item('i2', A1, 35_000, 'BNK-2')];
    const forward = match(transactions, items);
    const backward = match([...transactions].reverse(), [...items].reverse());
    expect(backward).toEqual(forward);
  });
});
