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
import { TEMPLATES, type ClientAttributes, type NotificationService } from './notification';

const SERVICE = 'notification-service';
/** Spec notification 3.1: the Gateway registers a contact (AZ-32). */
const REGISTERER = 'API_GATEWAY';
/** Spec notification 3.2: Transaction asks for a message (AZ-33). */
const SENDER = 'TRANSACTION';

const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;

// A reference to the customer and a phone number come in; a field of any other name, an identity among them, is refused
// (S-40). The reference is a token in proposed and the customer id in baseline (N-44), so its form is the mode's.
// G4: in baseline the Gateway holds the registration form and passes the NIK, the name and the account number on; the
// edge lets exactly those three through when the mode asks, and proposed refuses them like any unknown field.
const clientAttributeFields = {
  nik: z.string().max(64).optional(),
  nama: z.string().max(200).optional(),
  account_number: z.string().max(20).optional(),
};
const clientAttributesSchema = z.object(clientAttributeFields);
const noClientAttributes: Partial<typeof clientAttributeFields> = {};
const bodies = (customer: RegExp, acceptClientIdentity: boolean) => ({
  register: z.strictObject({
    ...(acceptClientIdentity ? clientAttributeFields : noClientAttributes),
    notification_domain_id: z.string().regex(customer),
    phone: z.string().regex(/^08[0-9]{8,12}$/),
    channel: z.literal('SMS'),
  }),
  send: z.strictObject({
    notif_token: z.string().regex(customer),
    template: z.enum(TEMPLATES),
    amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    transaction_id: z.string().regex(TRANSACTION_ID),
  }),
});

export interface NotificationHttpDeps {
  readonly clock: Clock;
  readonly issuer: string;
  readonly keys: JwksKeys;
  readonly notifications: Pick<NotificationService, 'register' | 'send'>;
  /** The form of the reference to the customer in this mode (N-44). */
  readonly customerRef: RegExp;
  /** G4: baseline only, see `clientAttributeFields`. */
  readonly acceptClientIdentity?: boolean;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/**
 * What the controller does, without the framework: prove the caller, check the shape, hand the work to the service.
 * `requesting_service` comes from the verified token only (invariant 7). Neither a phone number nor a message text is
 * ever in an answer, an error or a log.
 */
export class NotificationHttp {
  private readonly schemas: ReturnType<typeof bodies>;

  constructor(private readonly deps: NotificationHttpDeps) {
    this.schemas = bodies(deps.customerRef, deps.acceptClientIdentity === true);
  }

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
    const parsed = this.schemas.register.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const input = parsed.data;
    // The strict schema above already refused any other field; this one only reads the three that proposed never lets in.
    const sent = clientAttributesSchema.parse(input);
    const attributes: ClientAttributes = {
      ...(sent.nik === undefined ? {} : { nik: sent.nik }),
      ...(sent.nama === undefined ? {} : { nama: sent.nama }),
      ...(sent.account_number === undefined ? {} : { accountNumber: sent.account_number }),
    };
    const result = await this.deps.notifications.register({
      notificationDomainId: input.notification_domain_id,
      phone: input.phone,
      channel: input.channel,
      ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
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
    const parsed = this.schemas.send.safeParse(body);
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
