import { DomainError, type HttpClient, type TokenCache } from '@privpay/common';
import { z } from 'zod';
import {
  PrivacyRejectedError,
  TokenExpiredError,
  type FraudAttributes,
  type FraudClient,
  type NotificationClient,
  type PrivacyStatusClient,
} from './ports';

const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const pseudonymAnswer = z.object({ pseudonym: z.string().regex(PSEUDONYM) });
const fraudAnswer = z.object({
  risk_score: z.number().min(0).max(999.99),
  decision: z.enum(['ALLOW', 'HOLD_FOR_VERIFICATION', 'BLOCK']),
});
const sendAnswer = z.object({ status: z.enum(['SENT', 'FAILED']) });
const errorAnswer = z.object({ error: z.object({ reason: z.string() }) });

export interface ClientDeps {
  readonly http: HttpClient;
  /** Transaction's own service token for the service it calls (`aud` privacy-service, fraud-service, ...). */
  readonly serviceToken: Pick<TokenCache, 'get'>;
}

/**
 * N-40: the one answer that is about the row itself. Privacy (spec 4.7) refuses a status for good only with 409
 * TX_TERMINAL; 400 and 422 are faults of the caller and would come for every row, 404 does not exist (upsert), and
 * the rest (auth, rate, outage) is not about the row either. Marking those rows would hide a fixable fault for good.
 */
const FINAL_PATCH_ANSWERS: ReadonlySet<number> = new Set([409]);

const unavailable = (cause: string): DomainError => new DomainError('SERVICE_UNAVAILABLE', cause);

/** The calls to Privacy. `exchange` and `re-issue` and `PATCH` are idempotent, so the shared client may retry them. */
export class HttpPrivacyClient implements PrivacyStatusClient {
  constructor(private readonly deps: ClientDeps) {}

  /** X1 and X2 (PRD 7.2): the pseudonym of another service for the same person. `EXPIRED` has its own error (TF-04). */
  async exchange(request: {
    readonly sourcePseudonym: string;
    readonly targetService: 'FRAUD' | 'NOTIFICATION';
    readonly purpose: 'FRAUD_DETECTION' | 'NOTIFICATION';
    readonly transactionId: string;
  }): Promise<string> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/pseudonymize',
      body: {
        source_pseudonym: request.sourcePseudonym,
        target_service: request.targetService,
        purpose: request.purpose,
        transaction_id: request.transactionId,
      },
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    if (response.status === 410 && reasonOf(response.body) === 'EXPIRED') {
      throw new TokenExpiredError();
    }
    const parsed = pseudonymAnswer.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) throw unavailable('privacy_exchange');
    return parsed.data.pseudonym;
  }

  async reIssue(pseudonym: string, transactionId: string): Promise<string> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/re-issue',
      body: { pseudonym, transaction_id: transactionId },
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    const parsed = pseudonymAnswer.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) throw unavailable('privacy_reissue');
    return parsed.data.pseudonym;
  }

  async patchStatus(
    transactionId: string,
    status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED',
  ): Promise<void> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'PATCH',
      path: '/transaction-status',
      body: { transaction_id: transactionId, status },
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    if (FINAL_PATCH_ANSWERS.has(response.status)) throw new PrivacyRejectedError();
    if (response.status !== 200) throw unavailable('privacy_patch');
  }
}

function reasonOf(body: unknown): string | undefined {
  const parsed = errorAnswer.safeParse(body);
  return parsed.success ? parsed.data.error.reason : undefined;
}

/** `POST /fraud/assess`. Not idempotent: one attempt, whatever happens (NFR-12). */
export class HttpFraudClient implements FraudClient {
  constructor(private readonly deps: ClientDeps) {}

  async assess(request: {
    readonly subject: string;
    readonly amount: number;
    readonly txHour: number;
    readonly geohash: string;
    readonly identity?: FraudAttributes;
  }) {
    const response = await this.deps.http.request({
      service: 'fraud-service',
      method: 'POST',
      path: '/fraud/assess',
      body: {
        pseudonym: request.subject,
        amount: request.amount,
        tx_hour: request.txHour,
        geohash: request.geohash,
        // G3: only what the mode handed over, and only the values that exist.
        ...(request.identity?.nik === undefined ? {} : { nik: request.identity.nik }),
        ...(request.identity?.nama === undefined ? {} : { nama: request.identity.nama }),
        ...(request.identity?.accountNumber === undefined
          ? {}
          : { account_number: request.identity.accountNumber }),
      },
      idempotent: false,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    const parsed = fraudAnswer.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) throw unavailable('fraud_answer');
    return { riskScore: parsed.data.risk_score, decision: parsed.data.decision };
  }
}

/** `POST /notification/send`. Not idempotent: a second call is a second SMS, so one attempt only (NFR-12). */
export class HttpNotificationClient implements NotificationClient {
  constructor(private readonly deps: ClientDeps) {}

  async send(request: {
    readonly subject: string;
    readonly template: 'TX_COMPLETED' | 'TX_HELD_VERIFY' | 'TX_REJECTED';
    readonly amount: number;
    readonly transactionId: string;
  }) {
    const response = await this.deps.http.request({
      service: 'notification-service',
      method: 'POST',
      path: '/notification/send',
      body: {
        notif_token: request.subject,
        template: request.template,
        amount: request.amount,
        transaction_id: request.transactionId,
      },
      idempotent: false,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    const parsed = sendAnswer.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) throw unavailable('notification_answer');
    return parsed.data.status;
  }
}
