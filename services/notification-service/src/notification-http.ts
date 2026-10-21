import {
  authenticate,
  DomainError,
  parseBearer,
  unverifiedKid,
  type AuthHeaders,
  type Authenticated,
  type Clock,
  type JwksKeys,
} from '@privpay/common';
import { z } from 'zod';
import { TEMPLATES, type NotificationService } from './notification';

const SERVICE = 'notification-service';
/** Spec notification 3.1: the Gateway registers a contact (AZ-32). */
const REGISTERER = 'API_GATEWAY';
/** Spec notification 3.2: Transaction asks for a message (AZ-33). */
const SENDER = 'TRANSACTION';

const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;

// A token and a phone number come in; a field of any other name, an identity among them, is refused (S-40).
const register = z.strictObject({
  notification_domain_id: z.string().regex(PSEUDONYM),
  phone: z.string().regex(/^08[0-9]{8,12}$/),
  channel: z.literal('SMS'),
});
const send = z.strictObject({
  notif_token: z.string().regex(PSEUDONYM),
  template: z.enum(TEMPLATES),
  amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  transaction_id: z.string().regex(TRANSACTION_ID),
});

export interface NotificationHttpDeps {
  readonly clock: Clock;
  readonly issuer: string;
  readonly keys: JwksKeys;
  readonly notifications: Pick<NotificationService, 'register' | 'send'>;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/**
 * What the controller does, without the framework: prove the caller, check the shape, hand the work to the service.
 * `requesting_service` comes from the verified token only (invariant 7). Neither a phone number nor a message text is
 * ever in an answer, an error or a log.
 */
export class NotificationHttp {
  constructor(private readonly deps: NotificationHttpDeps) {}

  private async caller(headers: AuthHeaders): Promise<Authenticated> {
    // The keys are loaded for the key id a token claims before its signature is checked; an unknown id gains nothing.
    const bearer = parseBearer(single(headers['authorization']));
    const actor = single(headers['x-actor-token']);
    if (bearer !== undefined) await this.deps.keys.ensure(unverifiedKid(bearer));
    if (actor !== undefined) await this.deps.keys.ensure(unverifiedKid(actor));
    return authenticate(headers, {
      clock: this.deps.clock,
      issuer: this.deps.issuer,
      service: SERVICE,
      resolveKey: (kid) => this.deps.keys.resolveKey(kid),
    });
  }

  /** Spec notification 3.1. The caller is decided before the body is read, so another service learns nothing from it. */
  async register(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    if (who.requestingService !== REGISTERER) throw new DomainError('POLICY_NOT_ALLOWED');
    const parsed = register.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const input = parsed.data;
    const result = await this.deps.notifications.register({
      notificationDomainId: input.notification_domain_id,
      phone: input.phone,
      channel: input.channel,
    });
    return {
      created: result.created,
      body: {
        notification_domain_id: result.notificationDomainId,
        registered_at: result.registeredAt.toISOString(),
      },
    };
  }

  /** Spec notification 3.2. */
  async send(headers: AuthHeaders, body: unknown) {
    const who = await this.caller(headers);
    if (who.requestingService !== SENDER) throw new DomainError('POLICY_NOT_ALLOWED');
    const parsed = send.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const input = parsed.data;
    return this.deps.notifications.send({
      notifToken: input.notif_token,
      template: input.template,
      amount: input.amount,
      transactionId: input.transaction_id,
    });
  }
}
