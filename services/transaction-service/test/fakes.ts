import { DomainError } from '@privpay/common';
import {
  PrivacyRejectedError,
  TokenExpiredError,
  type FraudClient,
  type FraudVerdict,
  type NotificationClient,
  type NotificationTemplate,
  type PrivacyStatusClient,
  type PrivacyTransactionStatus,
  type SubjectReferencePort,
  type SubjectRow,
} from '../src/transaction';

// Doubles for the seams of the neighbours. They record what they were asked and fail on command; nothing here is a
// real person: every token is invented.

export class FakeSubjects implements SubjectReferencePort {
  /** Calls of `forFraud` / `forNotification` that throw TokenExpiredError before one succeeds. */
  expireFraud = 0;
  expireNotification = 0;
  failReissue = false;
  failFraudExchange = false;
  failNotificationExchange = false;
  readonly fraudRows: SubjectRow[] = [];
  readonly notificationRows: SubjectRow[] = [];
  readonly reissued: SubjectRow[] = [];

  forFraud(row: SubjectRow): Promise<string> {
    this.fraudRows.push(row);
    if (this.failFraudExchange) return Promise.reject(new DomainError('SERVICE_UNAVAILABLE'));
    if (this.expireFraud > 0) {
      this.expireFraud -= 1;
      return Promise.reject(new TokenExpiredError());
    }
    return Promise.resolve('PSEU-F0000001');
  }

  forNotification(row: SubjectRow): Promise<string> {
    this.notificationRows.push(row);
    if (this.failNotificationExchange)
      return Promise.reject(new DomainError('SERVICE_UNAVAILABLE'));
    if (this.expireNotification > 0) {
      this.expireNotification -= 1;
      return Promise.reject(new TokenExpiredError());
    }
    return Promise.resolve('PSEU-A0000001');
  }

  reissue(row: SubjectRow): Promise<{ customerSubjectRef: string; accountSubjectRef: string }> {
    this.reissued.push(row);
    if (this.failReissue) return Promise.reject(new DomainError('TX_TERMINAL'));
    return Promise.resolve({
      customerSubjectRef: 'PSEU-0000AAA1',
      accountSubjectRef: 'PSEU-0000AAA2',
    });
  }
}

export class FakeFraud implements FraudClient {
  decision: FraudVerdict = 'ALLOW';
  riskScore = 12.5;
  fail = false;
  /** Runs while the assessment is "in flight": a test uses it to let something else happen meanwhile. */
  onAssess: (() => Promise<void>) | undefined;
  readonly calls: { subject: string; amount: number; txHour: number; geohash: string }[] = [];

  async assess(request: { subject: string; amount: number; txHour: number; geohash: string }) {
    this.calls.push(request);
    await this.onAssess?.();
    if (this.fail) throw new DomainError('SERVICE_UNAVAILABLE');
    return { riskScore: this.riskScore, decision: this.decision };
  }
}

interface SentNotification {
  subject: string;
  template: NotificationTemplate;
  amount: number;
  transactionId: string;
}

export class FakeNotifications implements NotificationClient {
  fail = false;
  answer: 'SENT' | 'FAILED' = 'SENT';
  readonly sent: SentNotification[] = [];
  /** Shared with FakePrivacy by a test that cares about the order of the two. */
  trace: string[] | undefined;

  send(request: SentNotification) {
    this.trace?.push('notify');
    this.sent.push(request);
    if (this.fail) return Promise.reject(new DomainError('SERVICE_UNAVAILABLE'));
    return Promise.resolve(this.answer);
  }
}

export class FakePrivacy implements PrivacyStatusClient {
  fail = false;
  /** Transactions Privacy refuses for good (N-40): a 4xx about that row, not about Privacy being away. */
  readonly refused = new Set<string>();
  readonly patches: { transactionId: string; status: PrivacyTransactionStatus }[] = [];
  trace: string[] | undefined;

  patchStatus(transactionId: string, status: PrivacyTransactionStatus): Promise<void> {
    this.trace?.push('patch');
    this.patches.push({ transactionId, status });
    if (this.refused.has(transactionId)) return Promise.reject(new PrivacyRejectedError());
    return this.fail ? Promise.reject(new DomainError('SERVICE_UNAVAILABLE')) : Promise.resolve();
  }
}

export interface LogEntry {
  level: string;
  event: string;
  fields: object | undefined;
}
export function recordingLogger() {
  const entries: LogEntry[] = [];
  const at = (level: string) => (event: string, fields?: object) => {
    entries.push({ level, event, fields });
  };
  return {
    entries,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

/** A full set of neighbours for tests that only need the service to start and answer. */
export const neighbours = (options: { fraudDown?: boolean } = {}) => {
  const fraud = new FakeFraud();
  fraud.fail = options.fraudDown ?? false;
  return {
    subjects: new FakeSubjects(),
    fraud,
    notifications: new FakeNotifications(),
    privacy: new FakePrivacy(),
  };
};
