import {
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
    if (this.failFraudExchange) return Promise.reject(new Error('exchange'));
    if (this.expireFraud > 0) {
      this.expireFraud -= 1;
      return Promise.reject(new TokenExpiredError());
    }
    return Promise.resolve('PSEU-F0000001');
  }

  forNotification(row: SubjectRow): Promise<string> {
    this.notificationRows.push(row);
    if (this.failNotificationExchange) return Promise.reject(new Error('exchange'));
    if (this.expireNotification > 0) {
      this.expireNotification -= 1;
      return Promise.reject(new TokenExpiredError());
    }
    return Promise.resolve('PSEU-A0000001');
  }

  reissue(row: SubjectRow): Promise<{ customerToken: string; accountToken: string }> {
    this.reissued.push(row);
    if (this.failReissue) return Promise.reject(new Error('terminal'));
    return Promise.resolve({ customerToken: 'PSEU-0000AAA1', accountToken: 'PSEU-0000AAA2' });
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
    if (this.fail) throw new Error('down');
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

  send(request: SentNotification) {
    this.sent.push(request);
    if (this.fail) return Promise.reject(new Error('down'));
    return Promise.resolve(this.answer);
  }
}

export class FakePrivacy implements PrivacyStatusClient {
  fail = false;
  readonly patches: { transactionId: string; status: PrivacyTransactionStatus }[] = [];

  patchStatus(transactionId: string, status: PrivacyTransactionStatus): Promise<void> {
    this.patches.push({ transactionId, status });
    return this.fail ? Promise.reject(new Error('down')) : Promise.resolve();
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
