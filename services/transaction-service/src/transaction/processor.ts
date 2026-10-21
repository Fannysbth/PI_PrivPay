import { DomainError, type Clock, type Delay } from '@privpay/common';
import type { StoredTransaction, TransactionRepository, TransactionStatus } from './repository';

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
    'merchantExists' | 'insertPending' | 'findByKey' | 'finish'
  >;
  readonly clock: Clock;
  readonly delay: Delay;
  /** FRAUD_AMOUNT_THRESHOLD (PRD 17). */
  readonly fraudAmountThreshold: number;
  /** HTTP_TIMEOUT_MS: how long a loser waits for the winner (K-25, ADR-0009). */
  readonly waitMs: number;
}

/** How often a loser looks at the winner's row. Waiting is counted in these steps, not read from a wall clock. */
const POLL_MS = 100;

const conflict = (): DomainError => new DomainError('IDEMPOTENCY_CONFLICT');
const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');

/**
 * `POST /transaction` without the neighbours: the idempotency of ADR-0009 and the state of the row. Fraud,
 * Notification and Privacy are wired by M4-02; until then the decision is the one the spec gives to a Fraud that
 * cannot be reached, so no amount at or over the threshold is ever completed (NFR-24, spec transaction 6).
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
    if (created) return this.decide(request);
    return this.replay(request);
  }

  /** The winner (spec transaction 5, steps 2 and 3, until M4-02). */
  private async decide(request: TransactionRequest): Promise<ProcessResult> {
    const over = request.amount >= this.deps.fraudAmountThreshold;
    const status = over ? 'HELD' : 'COMPLETED';
    await this.deps.repository.finish(request.transactionId, {
      status,
      fraudDecision: over ? 'FRAUD_UNAVAILABLE' : null,
      completedAt: over ? null : this.deps.clock.now(),
    });
    return answer(201, request.transactionId, status);
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

function answer(
  httpStatus: 200 | 201,
  transactionId: string,
  status: Exclude<TransactionStatus, 'PENDING'>,
): ProcessResult {
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
