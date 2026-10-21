import type { Clock } from '@privpay/common';

/**
 * K-17: `TX-` followed by the epoch milliseconds (13 digits) and a counter of 3 digits that wraps per process, so
 * no database is needed and the result matches `^TX-[0-9]{1,29}$`. A thousand ids in one millisecond are distinct.
 */
export class TransactionIdGenerator {
  private counter = 0;

  constructor(private readonly clock: Clock) {}

  generate(): string {
    const sequence = String(this.counter).padStart(3, '0');
    this.counter = (this.counter + 1) % 1000;
    return `TX-${String(this.clock.now().getTime()).padStart(13, '0')}${sequence}`;
  }
}
