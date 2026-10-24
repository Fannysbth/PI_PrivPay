import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CustomerCounter } from './identity-provider';

const STORED = /^[0-9]{1,6}$/;

/**
 * The highest customer number ever handed out, kept in a file so a restart cannot hand one out twice (N-51 finding 1:
 * the Privacy database outlives the dev IdP, and a revoked customer_id would block the next registration that got it).
 * The number only goes up, also for deleted customers. A file that is there but unreadable stops the start: starting
 * again from zero would be the very reuse this prevents. It holds a number and nothing else.
 */
export function fileCustomerCounter(file: string): CustomerCounter {
  return {
    read(): number {
      let text: string;
      try {
        text = readFileSync(file, 'utf8').trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
      if (!STORED.test(text))
        throw new RangeError('customer counter file is not a customer number');
      return Number(text);
    },
    write(highest: number): void {
      mkdirSync(dirname(file), { recursive: true });
      // Written beside the file and renamed over it, so a crash leaves the old number or the new one, never half.
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, String(highest));
      renameSync(temporary, file);
    },
  };
}
