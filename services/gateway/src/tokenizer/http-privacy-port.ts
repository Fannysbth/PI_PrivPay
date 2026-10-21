import { DomainError, type HttpClient, type TokenCache } from '@privpay/common';
import { z } from 'zod';
import type { ErrorMasker } from '../error-masker';
import type { PrivacyPort, PseudonymizeRequest } from './privacy-port';

const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const answer = z.object({ pseudonym: z.string().regex(PSEUDONYM) });

export interface HttpPrivacyPortDeps {
  readonly http: HttpClient;
  readonly masker: ErrorMasker;
  /** The gateway's own service token for Privacy (`aud` privacy-service). */
  readonly serviceToken: Pick<TokenCache, 'get'>;
}

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
      body: {
        subject_type: request.subjectType,
        subject_id: request.subjectId,
        target_service: request.targetService,
        purpose: request.purpose,
        ...(request.transactionId === undefined ? {} : { transaction_id: request.transactionId }),
      },
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
}
