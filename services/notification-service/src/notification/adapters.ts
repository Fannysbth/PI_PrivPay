import { DomainError, type HttpClient, type TokenCache } from '@privpay/common';
import { z } from 'zod';
import type { PrivacyClient, SmsGateway } from './service';

const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const domainAnswer = z.object({ notification_domain_id: z.string().regex(PSEUDONYM) });

export interface HttpAdapterDeps {
  readonly http: HttpClient;
  /** Notification's own service token for the service it calls (`aud` privacy-service or sms-simulator). */
  readonly serviceToken: Pick<TokenCache, 'get'>;
}

/**
 * `POST /resolve-domain` of Privacy (spec privacy 4.4). It is idempotent, so the shared client may retry it (NFR-12).
 * Whatever is not a clear answer is a failure, and the reason is not kept: it is Privacy's to audit.
 */
export class HttpPrivacyClient implements PrivacyClient {
  constructor(private readonly deps: HttpAdapterDeps) {}

  async resolveDomain(notifToken: string): Promise<string> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/resolve-domain',
      body: { notif_token: notifToken },
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    const parsed = domainAnswer.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) {
      throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer');
    }
    return parsed.data.notification_domain_id;
  }
}

/** `POST /sms` of the simulator. A message is not idempotent: it is never retried (NFR-12, PRD 20 no. 12). */
export class HttpSmsGateway implements SmsGateway {
  constructor(private readonly deps: HttpAdapterDeps) {}

  async send(to: string, text: string): Promise<void> {
    const response = await this.deps.http.request({
      service: 'sms-simulator',
      method: 'POST',
      path: '/sms',
      body: { to, text },
      idempotent: false,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    if (response.status !== 202) throw new DomainError('SERVICE_UNAVAILABLE', 'sms_answer');
  }
}
