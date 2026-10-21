import type { DomainError } from '@privpay/common';
import type { PrivacyPort, PseudonymizeRequest } from './privacy-port';

/**
 * The second adapter of PrivacyPort (gateway spec 2): for tests and the contract vectors. It records what it was
 * asked and answers with a pseudonym made from the order of the calls, or with the error `decide` returns.
 */
export class FakePrivacyPort implements PrivacyPort {
  readonly calls: PseudonymizeRequest[] = [];
  private issued = 0;
  /** What was answered for a subject, so the same subject and context gets the same token (privacy spec 7.2). */
  private readonly known = new Map<string, string>();

  constructor(
    private readonly decide: (request: PseudonymizeRequest) => DomainError | undefined = () =>
      undefined,
  ) {}

  pseudonymize(request: PseudonymizeRequest): Promise<string> {
    this.calls.push(request);
    const failure = this.decide(request);
    if (failure !== undefined) return Promise.reject(failure);
    const key = [
      request.subjectType,
      request.subjectId,
      request.targetService,
      request.purpose,
    ].join('|');
    let pseudonym = this.known.get(key);
    if (pseudonym === undefined) {
      this.issued += 1;
      pseudonym = `PSEU-${this.issued.toString(16).toUpperCase().padStart(8, '0')}`;
      this.known.set(key, pseudonym);
    }
    return Promise.resolve(pseudonym);
  }
}
