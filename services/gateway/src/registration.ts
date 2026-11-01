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
import type { UserDirectory } from './user-directory';
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

export interface RegistrationDeps {
  readonly http: HttpClient;
  readonly privacy: PrivacyPort;
  readonly masker: ErrorMasker;
  /** The form of the domain reference of a customer in this mode (N-44): a token, or the customer id in baseline. */
  readonly domainRef: RegExp;
  /** Step A2 and its compensation at the IdP in use (the dev IdP or Keycloak, DK-04). */
  readonly users: UserDirectory;
  /** The gateway's own token for Notification. */
  readonly notificationToken: Pick<TokenCache, 'get'>;
  /**
   * G4, Tabel IV: baseline only. The form is held here, and the conventional system hands Notification the NIK, the name
   * and the account number beside the customer id and the phone. The e-mail is never forwarded (G2).
   */
  readonly forwardClientIdentity?: boolean;
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
    const { customerId, handle } = await this.deps.users.create(form.username);

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
      await this.registerPhone(domain, form.hp, {
        nik: form.nik,
        nama: form.nama,
        account_number: form.rekening,
      });
    } catch (error) {
      await this.compensate(customerId, handle, requestId);
      throw error instanceof DomainError
        ? error
        : new DomainError('SERVICE_UNAVAILABLE', 'registration');
    }
    return { status: 201, body: { status: 'REGISTERED' } };
  }

  private async registerPhone(
    domain: string,
    phone: string,
    attributes: { nik: string; nama: string; account_number: string },
  ): Promise<void> {
    if (!this.deps.domainRef.test(domain))
      throw new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer');
    const response = await this.deps.http.request({
      service: 'notification-service',
      method: 'POST',
      path: '/notification/register',
      body: {
        notification_domain_id: domain,
        phone,
        channel: 'SMS',
        ...(this.deps.forwardClientIdentity === true ? attributes : {}),
      },
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
  private async compensate(customerId: string, handle: string, requestId: string): Promise<void> {
    const attempt = async (step: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch {
        this.logger.warn(`registration_compensation_failed_${step}`, { request_id: requestId });
      }
    };
    await attempt('vault', () => this.deps.privacy.revokeCustomer(customerId));
    await attempt('user', () => this.deps.users.remove(handle));
  }
}
