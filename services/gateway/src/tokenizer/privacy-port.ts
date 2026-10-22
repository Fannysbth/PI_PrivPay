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
  /** A5 (gateway spec 6): the one place the registration's NIK, name, phone and account go. Idempotent (privacy 4.9). */
  storeIdentity(identity: IdentityToStore): Promise<void>;
  /** The compensation of a registration (ADR-0005, ADR-0014): empties the vault and revokes the tokens of a customer. */
  revokeCustomer(customerId: string): Promise<void>;
}

/** What `POST /identity` takes (privacy spec 4.9). The email of the form is not here: the vault has no column for it. */
export interface IdentityToStore {
  readonly customerId: string;
  readonly nik: string;
  readonly nama: string;
  readonly hp: string;
  readonly rekening: string;
}
