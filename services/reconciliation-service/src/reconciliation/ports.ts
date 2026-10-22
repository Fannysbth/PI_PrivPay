/** One COMPLETED transaction of a day as Transaction tells it (D1): no token and no identity. */
export interface CompletedTransaction {
  readonly transactionId: string;
  readonly amount: number;
  readonly completedAt: string;
}

/** `TransactionClient` of spec reconciliation 2: what Reconciliation reads from Transaction. */
export interface TransactionClient {
  /** Every COMPLETED transaction whose `completed_at` falls on `date` (UTC). Throws when Transaction cannot answer. */
  completedOn(date: string): Promise<readonly CompletedTransaction[]>;
}

/** `PrivacyClient` of spec reconciliation 2: tokens in and out, never an identity (except `open`, M4-07). */
export interface PrivacyClient {
  /**
   * D2: the account token (P6) of a transaction. `null` when Privacy has none for it (`TOKEN_NOT_FOUND` after retention,
   * or `REVOKED`): that transaction is counted unmatched. Throws when Privacy cannot answer.
   */
  accountToken(transactionId: string): Promise<string | null>;
}
