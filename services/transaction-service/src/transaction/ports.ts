import type { TransactionStatus } from './repository';

/** What the neighbours need to know about a row to name the person: tokens only, never an identity. */
export interface SubjectRow {
  readonly transactionId: string;
  readonly customerToken: string;
  readonly accountToken: string;
}

/** The exchange found the token past its life (PRD 7.2 EXPIRED); the one case that is worth a re-issue (TF-04). */
export class TokenExpiredError extends Error {
  constructor() {
    super('token_expired');
    this.name = 'TokenExpiredError';
  }
}

/**
 * ADR-0006: the only place where the two modes differ. The proposed adapter exchanges tokens through Privacy (X1, X2)
 * and issues them again (spec transaction 5, step 5); the baseline one hands the identity back as it is. A method
 * throws `TokenExpiredError` when the token expired, and anything else it throws is a failed step.
 */
export interface SubjectReferencePort {
  forFraud(row: SubjectRow): Promise<string>;
  forNotification(row: SubjectRow): Promise<string>;
  reissue(
    row: SubjectRow,
  ): Promise<{ readonly customerToken: string; readonly accountToken: string }>;
}

export type FraudVerdict = 'ALLOW' | 'HOLD_FOR_VERIFICATION' | 'BLOCK';

/** `POST /fraud/assess`: not idempotent, so never retried (NFR-12). */
export interface FraudClient {
  assess(request: {
    readonly subject: string;
    readonly amount: number;
    readonly txHour: number;
    readonly geohash: string;
  }): Promise<{ readonly riskScore: number; readonly decision: FraudVerdict }>;
}

export type NotificationTemplate = 'TX_COMPLETED' | 'TX_HELD_VERIFY' | 'TX_REJECTED';

/** `POST /notification/send`: a message twice is a second SMS, so never retried (NFR-12). */
export interface NotificationClient {
  send(request: {
    readonly subject: string;
    readonly template: NotificationTemplate;
    readonly amount: number;
    readonly transactionId: string;
  }): Promise<'SENT' | 'FAILED'>;
}

/** What Privacy calls a status (PRD asumsi 4): `HELD` is `IN_PROGRESS` there. */
export type PrivacyTransactionStatus = 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';

/** `PATCH /transaction-status`: idempotent, so the shared client may retry it. */
export interface PrivacyStatusClient {
  patchStatus(transactionId: string, status: PrivacyTransactionStatus): Promise<void>;
}

export const privacyStatusOf = (
  status: Exclude<TransactionStatus, 'PENDING'>,
): PrivacyTransactionStatus => (status === 'HELD' ? 'IN_PROGRESS' : status);
