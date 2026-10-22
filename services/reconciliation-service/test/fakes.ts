import { DomainError } from '@privpay/common';
import type { CompletedTransaction, PrivacyClient, TransactionClient } from '../src/reconciliation';

// Doubles for the neighbours of Reconciliation. They record what they were asked and fail on command; every token and
// amount here is invented (PRD 16 gives the shape).

export class FakeTransactions implements TransactionClient {
  completed: CompletedTransaction[] = [];
  fail = false;
  readonly dates: string[] = [];

  completedOn(date: string): Promise<readonly CompletedTransaction[]> {
    this.dates.push(date);
    if (this.fail) return Promise.reject(new DomainError('SERVICE_UNAVAILABLE'));
    return Promise.resolve(this.completed);
  }
}

export class FakePrivacy implements PrivacyClient {
  /** The account token by transaction id; `null` is a transaction Privacy has no token for. */
  tokens = new Map<string, string | null>();
  fail = false;
  readonly asked: string[] = [];

  accountToken(transactionId: string): Promise<string | null> {
    this.asked.push(transactionId);
    if (this.fail) return Promise.reject(new DomainError('SERVICE_UNAVAILABLE'));
    return Promise.resolve(this.tokens.get(transactionId) ?? null);
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

/** The two completed transactions of PRD 16 (TX-10002 is HELD and is never in the list Transaction gives). */
export const PRD16_COMPLETED: CompletedTransaction[] = [
  { transactionId: 'TX-10001', amount: 35_000, completedAt: '2026-10-05T12:05:08.000Z' },
  { transactionId: 'TX-10003', amount: 1_500_000, completedAt: '2026-10-05T14:28:04.000Z' },
];
export const A1 = 'PSEU-B80D2C4F';
export const A3 = 'PSEU-5A83F0B7';
