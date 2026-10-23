/** One COMPLETED transaction of a day as Transaction tells it (D1): no token and no identity. */
export interface CompletedTransaction {
  readonly transactionId: string;
  readonly amount: number;
  readonly completedAt: string;
}

/** One transaction as an audit may see it (spec transaction 3.4): no token and no identity. */
export interface TransactionDetail {
  readonly transactionId: string;
  readonly amount: number;
  readonly status: string;
}

/** The person behind a call: the id for the record, the token itself for Privacy, which checks the role again. */
export interface Actor {
  readonly actorId: string;
  readonly token: string;
}

/** The attributes Privacy released for one approved request (Tabel 5): only these three can ever be named. */
export interface DisclosedAttributes {
  readonly customer_id?: string;
  readonly nik?: string;
  readonly nama?: string;
}

/** `TransactionClient` of spec reconciliation 2: what Reconciliation reads from Transaction. */
export interface TransactionClient {
  /** Every COMPLETED transaction whose `completed_at` falls on `date` (UTC). Throws when Transaction cannot answer. */
  completedOn(date: string): Promise<readonly CompletedTransaction[]>;
  /** One transaction for an audit. Throws `TRANSACTION_NOT_FOUND` when there is none, anything else when it cannot answer. */
  byId(transactionId: string): Promise<TransactionDetail>;
}

/** `PrivacyClient` of spec reconciliation 2: tokens in and out, never an identity (except `open`, M4-07). */
export interface PrivacyClient {
  /**
   * D2: the account token (P6) of a transaction. `null` when Privacy has none for it (`TOKEN_NOT_FOUND` after retention,
   * or `REVOKED`): that transaction is counted unmatched. Throws when Privacy cannot answer.
   */
  accountSubjectRef(transactionId: string): Promise<string | null>;
  /**
   * E2: the audit token (P7) of the customer of a transaction, issued for this person. Privacy checks the role from the
   * actor token and refuses with its own reason; that reason is thrown as it is. Throws when Privacy cannot answer.
   */
  auditToken(transactionId: string, actor: Actor): Promise<string>;
  /**
   * E3: opens what was approved for this token. Never retried (a second call is a second use, NFR-12). The answer is
   * handed on and kept nowhere (T-14). Privacy's refusal is thrown as it is.
   */
  open(
    request: { auditToken: string; disclosureId: string },
    actor: Actor,
  ): Promise<DisclosedAttributes>;
}
