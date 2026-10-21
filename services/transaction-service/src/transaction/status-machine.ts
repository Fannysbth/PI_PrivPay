import { DomainError } from '@privpay/common';
import type { TransactionStatus } from './repository';

/** Spec transaction 4. `COMPLETED` and `FAILED` are terminal: nothing leaves them. */
const ALLOWED: readonly (readonly [TransactionStatus, TransactionStatus])[] = [
  ['PENDING', 'COMPLETED'],
  ['PENDING', 'HELD'],
  ['PENDING', 'FAILED'],
  ['HELD', 'COMPLETED'],
  ['HELD', 'FAILED'],
];

export const canTransition = (from: TransactionStatus, to: TransactionStatus): boolean =>
  ALLOWED.some(([a, b]) => a === from && b === to);

/** A caller that asks for a move the machine does not have is a bug in this service, not a client mistake. */
export function assertTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransition(from, to)) throw new DomainError('INTERNAL_ERROR', 'illegal_transition');
}
