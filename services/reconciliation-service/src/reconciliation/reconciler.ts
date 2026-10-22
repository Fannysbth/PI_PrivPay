export type BatchStatus = 'MATCHED' | 'PARTIAL' | 'MISMATCHED';

/** A COMPLETED transaction of the day with the account token Privacy gave for it (D2); `null` when Privacy has none. */
export interface ReconTransaction {
  readonly transactionId: string;
  readonly amount: number;
  readonly accountToken: string | null;
}

/** One line of the bank's report as stored: a token, an amount and the bank's own reference. Never an account number. */
export interface ReconItem {
  readonly id: string;
  readonly accountPseudonym: string;
  readonly amount: number;
  readonly bankReference: string;
}

export interface MatchResult {
  readonly pairs: readonly { readonly transactionId: string; readonly itemId: string }[];
  readonly unmatchedItems: readonly string[];
  readonly unmatchedTransactions: readonly string[];
  readonly status: BatchStatus;
}

// Ids and references are compared by length first, then by text, so TX-9 comes before TX-10 and the outcome never
// depends on the order the inputs arrive in.
const byText = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Spec reconciliation 3.2 steps 3 and 4 (D4, FR-41): `(account token, amount)` pairs a transaction with an item, one to
 * one. When several fit, the lowest transaction id takes the lowest bank reference, so the same day always gives the
 * same pairs. No I/O and no clock.
 *
 * K-22: `unmatched = (#items - matched) + (#transactions - matched)`; MATCHED when it is 0, MISMATCHED when nothing
 * matched although something exists, PARTIAL otherwise.
 */
export function match(
  transactions: readonly ReconTransaction[],
  items: readonly ReconItem[],
): MatchResult {
  const waiting = new Map<string, ReconItem[]>();
  for (const item of [...items].sort(
    (a, b) => byText(a.bankReference, b.bankReference) || byText(a.id, b.id),
  )) {
    const key = `${item.accountPseudonym}|${String(item.amount)}`;
    const queue = waiting.get(key);
    if (queue === undefined) waiting.set(key, [item]);
    else queue.push(item);
  }

  const pairs: { transactionId: string; itemId: string }[] = [];
  const unmatchedTransactions: string[] = [];
  for (const transaction of [...transactions].sort((a, b) =>
    byText(a.transactionId, b.transactionId),
  )) {
    const partner =
      transaction.accountToken === null
        ? undefined
        : waiting.get(`${transaction.accountToken}|${String(transaction.amount)}`)?.shift();
    if (partner === undefined) unmatchedTransactions.push(transaction.transactionId);
    else pairs.push({ transactionId: transaction.transactionId, itemId: partner.id });
  }

  const paired = new Set(pairs.map((pair) => pair.itemId));
  const unmatchedItems = [...items]
    .sort((a, b) => byText(a.bankReference, b.bankReference) || byText(a.id, b.id))
    .filter((item) => !paired.has(item.id))
    .map((item) => item.id);

  const unmatched = unmatchedItems.length + unmatchedTransactions.length;
  const status: BatchStatus =
    unmatched === 0 ? 'MATCHED' : pairs.length === 0 ? 'MISMATCHED' : 'PARTIAL';
  return { pairs, unmatchedItems, unmatchedTransactions, status };
}
