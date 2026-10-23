import { DomainError } from '@privpay/common';
import type { PrivacyPort } from './privacy-port';
import {
  IDEMPOTENCY_KEY,
  notificationBody,
  TRANSACTION_ID,
  settlementBody,
  transactionBody,
  type SettlementBody,
} from './schemas';

export interface TokenizerDeps {
  readonly privacy: PrivacyPort;
  /** K-17: a new `TX-` id for each request. */
  readonly newTransactionId: () => string;
  /**
   * Gateway spec 8 (G1): the baseline passes the NIK and the name of the request on as they are, where proposed drops
   * them (FR-03). Set by the composition root; the email is not passed on (G2 is open).
   */
  readonly forwardClientIdentity?: boolean;
}

export type TokenizeInput =
  | {
      readonly route: 'transaction';
      /** From the verified customer token, never from the body (invariant 7). */
      readonly claims: { readonly customerId: string };
      readonly idempotencyKey: string;
      readonly body: unknown;
    }
  | { readonly route: 'settlement'; readonly body: unknown }
  | {
      readonly route: 'notification';
      /** From the verified customer token, never from the body (invariant 7). */
      readonly claims: { readonly customerId: string };
      readonly body: unknown;
    };

/** What Transaction receives (gateway spec 4 step 4): tokens and business fields only. */
export interface TransactionOutbound {
  readonly transaction_id: string;
  readonly idempotency_key: string;
  readonly customer_token: string;
  readonly account_token: string;
  readonly merchant_id: string;
  readonly amount: number;
  readonly geohash: string;
  readonly nik?: string;
  readonly nama?: string;
}

export interface SettlementOutbound {
  readonly batch_date: string;
  readonly items: readonly {
    readonly account_pseudonym: string;
    readonly amount: number;
    readonly bank_reference: string;
  }[];
}

export type TokenizeOutput =
  | {
      readonly route: 'transaction';
      readonly outbound: TransactionOutbound;
      readonly transactionId: string;
    }
  | { readonly route: 'settlement'; readonly outbound: SettlementOutbound }
  | { readonly route: 'notification'; readonly outbound: NotificationOutbound };

/** What Notification receives for a customer who changes the phone: the domain token and the phone (spec notification 3.1). */
export interface NotificationOutbound {
  readonly notification_domain_id: string;
  readonly phone: string;
  readonly channel: 'SMS';
}

const invalid = (category: string): DomainError => new DomainError('VALIDATION_ERROR', category);

/** How many settlement accounts are sent to Privacy at once. */
const SETTLEMENT_PARALLEL = 16;

/**
 * Replaces the raw identifiers of a request by tokens and builds the payload for the service behind the gateway
 * (gateway spec 4, 5, 9). Pure: no framework, no clock, no I/O except the PrivacyPort, so a Lua plugin can be held to
 * the same contract vectors. The payload is built from the allow list; the raw values are only ever handed to Privacy.
 * When Privacy cannot answer, the error propagates and nothing is returned: no fallback to raw data (invariant 8).
 */
export class Tokenizer {
  constructor(private readonly deps: TokenizerDeps) {}

  async tokenize(input: TokenizeInput): Promise<TokenizeOutput> {
    if (input.route === 'transaction') return this.transaction(input);
    if (input.route === 'notification') return this.notification(input);
    return this.settlement(input.body);
  }

  private async transaction(
    input: Extract<TokenizeInput, { route: 'transaction' }>,
  ): Promise<TokenizeOutput> {
    const parsed = transactionBody.safeParse(input.body);
    if (!parsed.success) throw invalid('body');
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw invalid('idempotency_key');
    const transactionId = this.deps.newTransactionId();
    // A generator that breaks the format is a fault of ours, not of the client.
    if (!TRANSACTION_ID.test(transactionId))
      throw new DomainError('INTERNAL_ERROR', 'transaction_id');
    const { privacy } = this.deps;
    const context = { targetService: 'TRANSACTION', purpose: 'PAYMENT_PROCESSING', transactionId };
    // If one is refused or unavailable the whole request fails (gateway spec 4). The other token may already exist;
    // that is harmless, because a retry reuses it (privacy spec 7.2) and nothing is forwarded.
    const [customerSubjectRef, accountSubjectRef] = await Promise.all([
      privacy.pseudonymize({
        subjectType: 'CUSTOMER',
        subjectId: input.claims.customerId,
        ...context,
      }),
      privacy.pseudonymize({
        subjectType: 'ACCOUNT',
        subjectId: parsed.data.source_account,
        ...context,
      }),
    ]);
    const { merchant_id, amount, geohash, nik, nama } = parsed.data;
    const clientIdentity = this.deps.forwardClientIdentity === true;
    return {
      route: 'transaction',
      transactionId,
      outbound: {
        transaction_id: transactionId,
        idempotency_key: input.idempotencyKey,
        customer_token: customerSubjectRef,
        account_token: accountSubjectRef,
        merchant_id,
        amount,
        geohash,
        ...(clientIdentity && nik !== undefined ? { nik } : {}),
        ...(clientIdentity && nama !== undefined ? { nama } : {}),
      },
    };
  }

  /** AZ-02: the customer id is the token's, P5 is asked of Privacy, and the phone goes on with it. */
  private async notification(
    input: Extract<TokenizeInput, { route: 'notification' }>,
  ): Promise<TokenizeOutput> {
    const parsed = notificationBody.safeParse(input.body);
    if (!parsed.success) throw invalid('body');
    const domain = await this.deps.privacy.pseudonymize({
      subjectType: 'CUSTOMER',
      subjectId: input.claims.customerId,
      targetService: 'NOTIFICATION',
      purpose: 'NOTIFICATION_REGISTRATION',
    });
    return {
      route: 'notification',
      outbound: {
        notification_domain_id: domain,
        phone: parsed.data.phone,
        channel: parsed.data.channel,
      },
    };
  }

  private async settlement(raw: unknown): Promise<TokenizeOutput> {
    // The whole report is validated first, so an invalid item leaves no token behind (FR-32, TF-13).
    const parsed = settlementBody.safeParse(raw);
    if (!parsed.success) throw invalid('body');
    const report: SettlementBody = parsed.data;
    const accounts = [...new Set(report.items.map((item) => item.account_number))];
    const tokens = new Map<string, string>();
    for (let start = 0; start < accounts.length; start += SETTLEMENT_PARALLEL) {
      const chunk = accounts.slice(start, start + SETTLEMENT_PARALLEL);
      const answers = await Promise.all(
        chunk.map((account) =>
          this.deps.privacy.pseudonymize({
            subjectType: 'ACCOUNT',
            subjectId: account,
            targetService: 'RECONCILIATION',
            purpose: 'DAILY_RECONCILIATION',
          }),
        ),
      );
      chunk.forEach((account, index) => {
        const token = answers[index];
        if (token === undefined) throw new DomainError('INTERNAL_ERROR', 'privacy_answer');
        tokens.set(account, token);
      });
    }
    return {
      route: 'settlement',
      outbound: {
        batch_date: report.batch_date,
        items: report.items.map((item) => {
          const accountPseudonym = tokens.get(item.account_number);
          if (accountPseudonym === undefined)
            throw new DomainError('INTERNAL_ERROR', 'privacy_answer');
          return {
            account_pseudonym: accountPseudonym,
            amount: item.amount,
            bank_reference: item.bank_reference,
          };
        }),
      },
    };
  }
}
