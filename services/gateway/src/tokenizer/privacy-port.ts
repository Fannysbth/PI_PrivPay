/** One call of `POST /pseudonymize` form 1 (privacy spec 4.1), as the gateway makes it. */
export interface PseudonymizeRequest {
  readonly subjectType: 'CUSTOMER' | 'ACCOUNT';
  /** The raw customer id or account number: it goes to Privacy and nowhere else (invariant 1). */
  readonly subjectId: string;
  readonly targetService: string;
  readonly purpose: string;
  readonly transactionId?: string;
}

/**
 * The seam between the tokenizer and Privacy Service (gateway spec 2). It answers with a pseudonym or throws a
 * DomainError: SERVICE_UNAVAILABLE when Privacy cannot be reached (fail closed, invariant 8), or the refusal Privacy
 * gave. There is no way to get a raw value back from it.
 */
export interface PrivacyPort {
  pseudonymize(request: PseudonymizeRequest): Promise<string>;
}
