// The requests and results of TokenService (spec privacy 4.1). Shapes only: every value is checked before use.

/** What every form carries. `requestingService` is from the `azp` claim of the service token, never from a body (invariant 7). */
export interface CommonRequest {
  readonly requestingService: string;
  readonly actorId?: string;
}

/** Form 1: from identity (the Gateway only). */
export interface GenerateRequest extends CommonRequest {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly transactionId?: string;
}

/** Form 2: the caller trades a token of its own for one of another service (TRANSACTION only; Tabel 2). */
export interface ExchangeRequest extends CommonRequest {
  readonly sourcePseudonym: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly transactionId: string;
}

/** Form 3: Reconciliation asks for P6 or P7 by transaction id; for P7 the actor must be an auditor. */
export interface FromTransactionRequest extends CommonRequest {
  readonly transactionId: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly subjectType: string;
  /** From the actor token (`X-Actor-Token`); only P7 looks at it. */
  readonly actorRole?: string;
}

/** Re-issue: TRANSACTION asks for a new token in place of one that expired (spec privacy 4.4). */
export interface ReIssueRequest extends CommonRequest {
  readonly pseudonym: string;
  readonly transactionId: string;
}

export interface TokenResult {
  readonly pseudonym: string;
  readonly expiresAt: Date;
  readonly reused: boolean;
}

/** What `issue` made or found, in the terms the audit row and the result need. */
export interface Issued extends TokenResult {
  readonly mappingId: string;
  readonly keyVersion: number;
}
