import { DomainError, type Clock, type Delay, type Logger } from '@privpay/common';
import { Followups, reasonOf, type MutableSubject, type Settled } from './followups';
import type {
  FraudClient,
  NotificationClient,
  PrivacyStatusClient,
  SubjectReferencePort,
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
    | 'merchantExists'
    | 'insertPending'
    | 'findByKey'
    | 'findById'
    | 'finish'
    | 'updateTokens'
    | 'markPrivacySynced'
    | 'markPrivacyRejected'
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

/** What the winner decided. Everything that follows (Privacy, the customer) hangs on it. */
interface Decision {
  readonly status: Settled;
  readonly fraudDecision: FraudDecision | null;
  readonly riskScore: number | null;
}

/**
 * `POST /transaction`: the idempotency of ADR-0009, then the orchestration of spec transaction 5. Fraud, Notification
 * and Privacy are reached through ports. A Fraud that cannot answer holds the transaction and never completes it
 * (NFR-24, spec transaction 6); Notification and Privacy failing never change the status (spec transaction 7).
 */
export class TransactionProcessor {
  private readonly followups: Followups;

  constructor(private readonly deps: TransactionProcessorDeps) {
    this.followups = new Followups(deps);
  }

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
    // The customer first: Privacy refuses a re-issue once it sees the transaction as final (TX_TERMINAL), and a token
    // that expired meanwhile (TF-04) can only be issued again before that.
    await this.followups.notify(subject, request.amount, decision.status);
    await this.followups.patchPrivacy(request.transactionId, decision.status);
    return answer(201, request.transactionId, decision.status);
  }

  /** Spec transaction 5, step 2. */
  private async decide(request: TransactionRequest, subject: MutableSubject): Promise<Decision> {
    if (request.amount < this.deps.fraudAmountThreshold) {
      return { status: 'COMPLETED', fraudDecision: null, riskScore: null };
    }
    try {
      const verdict = await this.followups.withReissue(subject, async (row) =>
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
    } catch (error) {
      // NFR-24, TF-11: no answer from Fraud (or no token for it) never turns into a completion.
      this.deps.logger.warn('fraud_unavailable', {
        transaction_id: request.transactionId,
        reason: reasonOf(error),
      });
      return { status: 'HELD', fraudDecision: 'FRAUD_UNAVAILABLE', riskScore: null };
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
