import type { Clock } from '@privpay/common';
import type { ClientAttributes, ContactRepository, SendStatus } from './contacts';

/** `PrivacyClient` of spec notification 2: it turns a notification token into the domain token, never into a person. */
export interface PrivacyClient {
  /** Throws when Privacy refuses or cannot be reached. */
  resolveDomain(notifToken: string): Promise<string>;
}

/** `SmsGateway` of spec notification 2: the real adapter talks to the simulator, the fake one counts. */
export interface SmsGateway {
  /** Throws when the message was not accepted. */
  send(to: string, text: string): Promise<void>;
}

export const TEMPLATES = ['TX_COMPLETED', 'TX_HELD_VERIFY', 'TX_REJECTED'] as const;
export type Template = (typeof TEMPLATES)[number];

/** The fixed texts of K-21: an amount and nothing about a person. */
const TEXT: Readonly<Record<Template, (amount: number) => string>> = {
  TX_COMPLETED: (amount) => `Transaksi Rp${String(amount)} berhasil.`,
  TX_HELD_VERIFY: (amount) => `Transaksi Rp${String(amount)} sedang diverifikasi.`,
  TX_REJECTED: (amount) => `Transaksi Rp${String(amount)} ditolak.`,
};

const CHANNEL = 'SMS';

export interface RegisterRequest {
  readonly notificationDomainId: string;
  readonly phone: string;
  readonly channel: 'SMS';
  /** G4: kept only by a mode whose table has the columns; never part of a message. */
  readonly attributes?: ClientAttributes;
}
export interface Registered {
  readonly created: boolean;
  readonly notificationDomainId: string;
  readonly registeredAt: Date;
}
export interface SendRequest {
  readonly notifToken: string;
  readonly template: Template;
  readonly amount: number;
  /** Only for the caller's own correlation; the log of the platform records it, this table does not. */
  readonly transactionId: string;
}

export interface NotificationServiceDeps {
  readonly contacts: Pick<ContactRepository, 'upsert' | 'phoneOf' | 'log'>;
  readonly privacy: PrivacyClient;
  readonly sms: SmsGateway;
  readonly clock: Clock;
}

/**
 * Contacts by domain token, and generic SMS (spec notification 3). It is the one module that touches a phone number,
 * and it never writes one, or the text it sends, to a log, a metric or an error. Sending is not idempotent: it is
 * tried once and never repeated here (PRD 20 no. 12).
 */
export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  async register(request: RegisterRequest): Promise<Registered> {
    const result = await this.deps.contacts.upsert(
      request.notificationDomainId,
      request.phone,
      request.channel,
      this.deps.clock.now(),
      request.attributes,
    );
    return { ...result, notificationDomainId: request.notificationDomainId };
  }

  /**
   * Every failure of Privacy, of the contact or of the SMS is `FAILED`, never an error to the caller: Transaction is
   * completed whatever happens here (spec notification 5). A database fault is not a failed notification and still
   * propagates.
   */
  async send(request: SendRequest): Promise<{ status: SendStatus }> {
    let recipient: string;
    try {
      recipient = await this.deps.privacy.resolveDomain(request.notifToken);
    } catch {
      // Nobody is known to be the recipient, so there is no row that could name one.
      return { status: 'FAILED' };
    }

    const phone = await this.deps.contacts.phoneOf(recipient);
    let status: SendStatus = 'FAILED';
    if (phone !== undefined) {
      try {
        await this.deps.sms.send(phone, TEXT[request.template](request.amount));
        status = 'SENT';
      } catch {
        // The message may or may not have gone out; it is not sent again.
      }
    }
    await this.deps.contacts.log({
      sender: request.notifToken,
      recipient,
      template: request.template,
      channel: CHANNEL,
      status,
      sentAt: this.deps.clock.now(),
    });
    return { status };
  }
}
