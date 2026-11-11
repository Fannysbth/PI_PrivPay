import { DomainError, type HttpClient, type TokenCache } from '@privpay/common';
import { z } from 'zod';
import type { ErrorMasker } from '../error-masker';
import type { IdentityToStore, PrivacyPort, PseudonymizeRequest } from './privacy-port';

const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const answer = z.object({ pseudonym: z.string().regex(PSEUDONYM) });
const batchAnswer = z.object({ items: z.array(answer).min(1).max(2) });

export interface HttpPrivacyPortDeps {
  readonly http: HttpClient;
  readonly masker: ErrorMasker;
  /** The gateway's own service token for Privacy (`aud` privacy-service). */
  readonly serviceToken: Pick<TokenCache, 'get'>;
}

const identityBody = (request: PseudonymizeRequest) => ({
  subject_type: request.subjectType,
  subject_id: request.subjectId,
  target_service: request.targetService,
  purpose: request.purpose,
  ...(request.transactionId === undefined ? {} : { transaction_id: request.transactionId }),
});

/**
 * The adapter of PrivacyPort that calls Privacy Service (gateway spec 4 step 3). `POST /pseudonymize` form 1 is
 * idempotent, so the shared client may retry it (NFR-12). Anything that is not a clear answer is fail closed: a 5xx,
 * a timeout, or a body that is not a pseudonym is SERVICE_UNAVAILABLE and the request goes no further (invariant 8).
 */
export class HttpPrivacyPort implements PrivacyPort {
  constructor(private readonly deps: HttpPrivacyPortDeps) {}

  async pseudonymize(request: PseudonymizeRequest): Promise<string> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/pseudonymize',
      body: identityBody(request),
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    if (response.status >= 500) throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_5xx');
    if (response.status < 200 || response.status > 299) {
      throw this.deps.masker.fromDownstream(response.status, response.body);
    }
    const parsed = answer.safeParse(response.body);
    if (!parsed.success) throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer');
    return parsed.data.pseudonym;
  }

  /**
   * ADR-0019. Idempotent like the single call (the same pair gives the same tokens back), so the shared client may
   * retry it. An answer with another number of items than asked is a fault, never a value to forward.
   */
  async pseudonymizeBatch(requests: readonly PseudonymizeRequest[]): Promise<string[]> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/pseudonymize/batch',
      body: { requests: requests.map(identityBody) },
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    if (response.status >= 500) throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_5xx');
    if (response.status < 200 || response.status > 299) {
      throw this.deps.masker.fromDownstream(response.status, response.body);
    }
    const parsed = batchAnswer.safeParse(response.body);
    if (!parsed.success || parsed.data.items.length !== requests.length) {
      throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer');
    }
    return parsed.data.items.map((item) => item.pseudonym);
  }

  async storeIdentity(identity: IdentityToStore): Promise<void> {
    await this.send('/identity', {
      customer_id: identity.customerId,
      nik: identity.nik,
      nama: identity.nama,
      hp: identity.hp,
      rekening: identity.rekening,
    });
  }

  async revokeCustomer(customerId: string): Promise<void> {
    await this.send('/subject/revoke', { subject_type: 'CUSTOMER', subject_id: customerId });
  }

  /** Both calls are idempotent (privacy 4.9, 4.6), so the shared client may retry them (NFR-12). */
  private async send(path: string, body: object): Promise<void> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path,
      body,
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    if (response.status >= 500) throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_5xx');
    if (response.status < 200 || response.status > 299) {
      throw this.deps.masker.fromDownstream(response.status, response.body);
    }
  }
}
