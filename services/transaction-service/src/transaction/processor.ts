import { DomainError, type Clock, type Delay, type Logger } from '@privpay/common';
import {
  privacyStatusOf,
  TokenExpiredError,
  type FraudClient,
  type NotificationClient,
  type NotificationTemplate,
  type PrivacyStatusClient,
  type SubjectReferencePort,
  type SubjectRow,
} from './ports';
import type {
  FraudDecision,
  StoredTransaction,
  TransactionRepository,
  TransactionStatus,
} from './repository';

/** What Gateway sends (spec transaction 3.1). The identity of the customer is not in it, only tokens. */
export interface TransactionRequest {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly customerToken: string;
  readonly accountToken: string;
  readonly merchantId: string;
  readonly amount: number;
  readonly geohash: string;
}

export interface ProcessResult {
  readonly status: Exclude<TransactionStatus, 'PENDING'>;
  readonly httpStatus: 200 | 201;
  readonly body: { readonly transaction_id: string; readonly status: string };
}

export interface TransactionProcessorDeps {
  readonly repository: Pick<
    TransactionRepository,
    'merchantExists' | 'insertPending' | 'findByKey' | 'findById' | 'finish' | 'updateTokens'
  >;
  readonly clock: Clock;
  readonly delay: Delay;
  /** FRAUD_AMOUNT_THRESHOLD (PRD 17). */
  readonly fraudAmountThreshold: number;
  /** HTTP_TIMEOUT_MS: how long a loser waits for the winner (K-25, ADR-0009). */
  readonly waitMs: number;
  readonly subjects: SubjectReferencePort;
  readonly fraud: FraudClient;
  readonly notifications: NotificationClient;
  readonly privacy: PrivacyStatusClient;
  /** Only the transaction id and a reason are ever logged (invariant 6). */
  readonly logger: Pick<Logger, 'warn'>;
}

/** How often a loser looks at the winner's row. Waiting is counted in these steps, not read from a wall clock. */
const POLL_MS = 100;

const conflict = (): DomainError => new DomainError('IDEMPOTENCY_CONFLICT');
const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');

type Settled = Exclude<TransactionStatus, 'PENDING'>;
type MutableSubject = { -readonly [K in keyof SubjectRow]: SubjectRow[K] };

/** What the winner decided. Everything that follows (Privacy, the customer) hangs on it. */
interface Decision {
  readonly status: Settled;
  readonly fraudDecision: FraudDecision | null;
  readonly riskScore: number | null;
}

const TEMPLATES = {
  COMPLETED: 'TX_COMPLETED',
  HELD: 'TX_HELD_VERIFY',
  FAILED: 'TX_REJECTED',
} as const satisfies Record<Settled, NotificationTemplate>;

/**
 * `POST /transaction`: the idempotency of ADR-0009, then the orchestration of spec transaction 5. Fraud, Notification
 * and Privacy are reached through ports. A Fraud that cannot answer holds the transaction and never completes it
 * (NFR-24, spec transaction 6); Notification and Privacy failing never change the status (spec transaction 7).
 */
export class TransactionProcessor {
  constructor(private readonly deps: TransactionProcessorDeps) {}

  async process(request: TransactionRequest): Promise<ProcessResult> {
    // K-16: refuse what the platform would never accept before a row exists. The amount is whole rupiah.
    if (!Number.isSafeInteger(request.amount) || request.amount < 1) throw invalid();
    if (!(await this.deps.repository.merchantExists(request.merchantId))) throw invalid();

    const created = await this.deps.repository.insertPending({
      transactionId: request.transactionId,
      idempotencyKey: request.idempotencyKey,
      customerToken: request.customerToken,
      accountToken: request.accountToken,
      merchantId: request.merchantId,
      amount: request.amount,
      geohash: request.geohash,
      createdAt: this.deps.clock.now(),
    });
    if (created) return this.orchestrate(request);
    return this.replay(request);
  }

  /** The winner (spec transaction 5, steps 2 to 4). */
  private async orchestrate(request: TransactionRequest): Promise<ProcessResult> {
    const subject: MutableSubject = {
      transactionId: request.transactionId,
      customerToken: request.customerToken,
      accountToken: request.accountToken,
    };
    const decision = await this.decide(request, subject);
    const completedAt = decision.status === 'COMPLETED' ? this.deps.clock.now() : null;
    const moved = await this.deps.repository.finish(request.transactionId, {
      ...decision,
      completedAt,
    });
    if (!moved) {
      // The sweeper marked the row FAILED while this request was working (spec transaction 5, step 6). Its word stands:
      // answer what is stored and tell neither Privacy nor the customer a second story.
      const stored = await this.deps.repository.findById(request.transactionId);
      if (stored === undefined || stored.status === 'PENDING') {
        throw new DomainError('INTERNAL_ERROR');
      }
      return answer(201, stored.transactionId, stored.status);
    }
    await this.patchPrivacy(request.transactionId, decision.status);
    await this.notify(request, subject, decision.status);
    return answer(201, request.transactionId, decision.status);
  }

  /** Spec transaction 5, step 2. */
  private async decide(request: TransactionRequest, subject: MutableSubject): Promise<Decision> {
    if (request.amount < this.deps.fraudAmountThreshold) {
      return { status: 'COMPLETED', fraudDecision: null, riskScore: null };
    }
    try {
      const verdict = await this.withReissue(request, subject, async (row) =>
        this.deps.fraud.assess({
          subject: await this.deps.subjects.forFraud(row),
          amount: request.amount,
          txHour: this.deps.clock.now().getUTCHours(),
          geohash: request.geohash,
        }),
      );
      const status =
        verdict.decision === 'ALLOW'
          ? 'COMPLETED'
          : verdict.decision === 'BLOCK'
            ? 'FAILED'
            : 'HELD';
      return { status, fraudDecision: verdict.decision, riskScore: verdict.riskScore };
    } catch {
      // NFR-24, TF-11: no answer from Fraud (or no token for it) never turns into a completion.
      this.deps.logger.warn('fraud_unavailable', {
        transaction_id: request.transactionId,
        reason: 'SERVICE_UNAVAILABLE',
      });
      return { status: 'HELD', fraudDecision: 'FRAUD_UNAVAILABLE', riskScore: null };
    }
  }

  /** Spec transaction 5, step 3. The status here stays; Privacy catches up when it can. */
  private async patchPrivacy(transactionId: string, status: Settled): Promise<void> {
    try {
      await this.deps.privacy.patchStatus(transactionId, privacyStatusOf(status));
    } catch {
      this.deps.logger.warn('status_patch_failed', {
        transaction_id: transactionId,
        reason: 'SERVICE_UNAVAILABLE',
      });
    }
  }

  /** Spec transaction 5, step 4. Not retried and not resent: a second call is a second SMS (NFR-12). */
  private async notify(
    request: TransactionRequest,
    subject: MutableSubject,
    status: Settled,
  ): Promise<void> {
    try {
      const sent = await this.withReissue(request, subject, async (row) =>
        this.deps.notifications.send({
          subject: await this.deps.subjects.forNotification(row),
          template: TEMPLATES[status],
          amount: request.amount,
          transactionId: request.transactionId,
        }),
      );
      if (sent === 'SENT') return;
    } catch {
      // Falls through to the same record as an answer of FAILED.
    }
    this.deps.logger.warn('notification_failed', {
      transaction_id: request.transactionId,
      reason: 'SERVICE_UNAVAILABLE',
    });
  }

  /**
   * TF-04, spec transaction 5, step 5: a token that expired in the middle of the work is issued again and the step
   * tried once more. `row` is updated in place so the later steps use the new tokens. Any other failure, and a
   * second expiry, is the failure of the step.
   */
  private async withReissue<T>(
    request: TransactionRequest,
    row: MutableSubject,
    step: (row: SubjectRow) => Promise<T>,
  ): Promise<T> {
    try {
      return await step({ ...row });
    } catch (error) {
      if (!(error instanceof TokenExpiredError)) throw error;
      const issued = await this.deps.subjects.reissue({ ...row });
      await this.deps.repository.updateTokens(request.transactionId, issued);
      row.customerToken = issued.customerToken;
      row.accountToken = issued.accountToken;
      return step({ ...row });
    }
  }

  /** The loser (ADR-0009 item 3 and 4): same content gets the stored answer, anything else is a conflict. */
  private async replay(request: TransactionRequest): Promise<ProcessResult> {
    let stored = await this.deps.repository.findByKey(request.idempotencyKey);
    // No row under this key: the insert was refused by the transaction id, which belongs to another request.
    if (stored === undefined || !sameContent(stored, request)) throw conflict();

    let waited = 0;
    while (stored.status === 'PENDING' && waited < this.deps.waitMs) {
      const step = Math.min(POLL_MS, this.deps.waitMs - waited);
      await this.deps.delay.wait(step);
      waited += step;
      const again = await this.deps.repository.findByKey(request.idempotencyKey);
      if (again === undefined) throw conflict();
      stored = again;
    }
    // Still PENDING: the winner is slow or gone. The caller may repeat the request safely.
    if (stored.status === 'PENDING') throw conflict();
    return answer(200, stored.transactionId, stored.status);
  }
}

function answer(httpStatus: 200 | 201, transactionId: string, status: Settled): ProcessResult {
  return { status, httpStatus, body: { transaction_id: transactionId, status } };
}

/** ADR-0009: the five fields of the request against the stored row; nothing secret is compared or stored. */
function sameContent(stored: StoredTransaction, request: TransactionRequest): boolean {
  return (
    stored.customerToken === request.customerToken &&
    stored.accountToken === request.accountToken &&
    stored.merchantId === request.merchantId &&
    stored.amount === request.amount &&
    stored.geohash === request.geohash
  );
}
