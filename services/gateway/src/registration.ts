import {
  createLogger,
  DomainError,
  type HttpClient,
  type Logger,
  type TokenCache,
} from '@privpay/common';
import { z } from 'zod';
import type { ErrorMasker } from './error-masker';
import type { PrivacyPort } from './tokenizer/privacy-port';
import { PHONE } from './tokenizer/schemas';

// The form of A1 (gateway spec 6). Everything in it is real data and none of it is logged, answered or kept here: it goes
// to Privacy (NIK, name, phone, account) or is dropped (the email, which the vault has no column for).
const registrationBody = z.strictObject({
  nik: z.string().regex(/^[0-9]{16}$/),
  nama: z.string().regex(/^[\p{L} .'-]{1,100}$/u),
  hp: z.string().regex(PHONE),
  email: z.email().max(200),
  rekening: z.string().regex(/^[0-9]{8,20}$/),
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/),
});

const created = z.object({ customer_id: z.string().regex(/^CUST-[0-9]{6}$/) });

export interface RegistrationDeps {
  readonly http: HttpClient;
  readonly privacy: PrivacyPort;
  readonly masker: ErrorMasker;
  /** The form of the domain reference of a customer in this mode (N-44): a token, or the customer id in baseline. */
  readonly domainRef: RegExp;
  /** The gateway's own token for the dev IdP admin API (`aud` dev-idp) and for Notification. */
  readonly idpAdminToken: Pick<TokenCache, 'get'>;
  readonly notificationToken: Pick<TokenCache, 'get'>;
  /** Only a request id and a reason are ever logged (invariant 6). */
  readonly logger?: Pick<Logger, 'warn'>;
}

/**
 * `POST /register` (gateway spec 6, ADR-0005): A2 the user at the IdP, A5 the identity in the vault, A3 the domain token,
 * A4 the phone at Notification, last of all, so the phone is stored only when everything else worked. A failure after A2
 * runs the compensation (the vault is emptied by `revoke_subject`, ADR-0014, and the IdP user removed) and answers 503;
 * a compensation that fails too is logged by request id and leaves a user at the IdP (a known limit). Every step is
 * idempotent, so the shared client retries it. The whole form is checked before anything is called.
 */
export class RegistrationFlow {
  private readonly logger: Pick<Logger, 'warn'>;

  constructor(private readonly deps: RegistrationDeps) {
    this.logger = deps.logger ?? createLogger({ service: 'gateway' });
  }

  async register(body: unknown, requestId: string): Promise<{ status: 201; body: object }> {
    const parsed = registrationBody.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'registration_body');
    const form = parsed.data;

    // A2: the user at the IdP. Not repeated by the client (a second call would be a second user).
    const customerId = await this.createUser(form.username);

    // From here on, any failure takes back what was done.
    try {
      await this.deps.privacy.storeIdentity({
        customerId,
        nik: form.nik,
        nama: form.nama,
        hp: form.hp,
        rekening: form.rekening,
      });
      const domain = await this.deps.privacy.pseudonymize({
        subjectType: 'CUSTOMER',
        subjectId: customerId,
        targetService: 'NOTIFICATION',
        purpose: 'NOTIFICATION_REGISTRATION',
      });
      await this.registerPhone(domain, form.hp);
    } catch (error) {
      await this.compensate(customerId, requestId);
      throw error instanceof DomainError
        ? error
        : new DomainError('SERVICE_UNAVAILABLE', 'registration');
    }
    return { status: 201, body: { status: 'REGISTERED' } };
  }

  private async createUser(username: string): Promise<string> {
    const response = await this.deps.http.request({
      service: 'idp',
      method: 'POST',
      path: '/admin/users',
      body: { username },
      idempotent: false,
      authorization: `Bearer ${await this.deps.idpAdminToken.get()}`,
    });
    const parsed = created.safeParse(response.body);
    if (response.status === 201 && parsed.success) return parsed.data.customer_id;
    // A username that is taken is the caller's to change; anything else is the IdP being away or refusing us.
    if (response.status === 422) throw new DomainError('VALIDATION_ERROR', 'username');
    throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
  }

  private async registerPhone(domain: string, phone: string): Promise<void> {
    if (!this.deps.domainRef.test(domain))
      throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer');
    const response = await this.deps.http.request({
      service: 'notification-service',
      method: 'POST',
      path: '/notification/register',
      body: { notification_domain_id: domain, phone, channel: 'SMS' },
      // Upsert keyed by the domain token (spec notification 3.1): safe to repeat.
      idempotent: true,
      authorization: `Bearer ${await this.deps.notificationToken.get()}`,
    });
    if (response.status < 200 || response.status > 299) {
      throw response.status >= 500
        ? new DomainError('SERVICE_UNAVAILABLE', 'notification_5xx')
        : this.deps.masker.fromDownstream(response.status, response.body);
    }
  }

  /**
   * ADR-0005: the vault first (the only place real data was put), then the user. Each is tried on its own. The vault is
   * emptied even when A5 reported a failure: an answer lost on the way may still have stored the identity, and emptying a
   * vault that has nothing is only an audited "nothing there" (privacy spec 4.6).
   */
  private async compensate(customerId: string, requestId: string): Promise<void> {
    const attempt = async (step: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch {
        this.logger.warn(`registration_compensation_failed_${step}`, { request_id: requestId });
      }
    };
    await attempt('vault', () => this.deps.privacy.revokeCustomer(customerId));
    await attempt('user', async () => {
      const response = await this.deps.http.request({
        service: 'idp',
        method: 'DELETE',
        path: `/admin/users/${customerId}`,
        idempotent: true,
        authorization: `Bearer ${await this.deps.idpAdminToken.get()}`,
      });
      if (response.status < 200 || response.status > 299)
        throw new DomainError('SERVICE_UNAVAILABLE');
    });
  }
}
