import { nextRunAt } from '@privpay/common';
import { previousDate } from '../src/reconciliation';

// Seam: the daily schedule of K-23 (RECON_DAILY_RUN_UTC, default 00:10), pure and with an injected clock. Nothing waits
// for real time.
describe('M4-06 K-23 nextRunAt', () => {
  it.each([
    ['2026-10-06T00:05:00.000Z', '00:10', '2026-10-06T00:10:00.000Z'],
    ['2026-10-06T00:10:00.000Z', '00:10', '2026-10-07T00:10:00.000Z'],
    ['2026-10-06T00:10:00.001Z', '00:10', '2026-10-07T00:10:00.000Z'],
    ['2026-12-31T23:30:00.000Z', '00:10', '2027-01-01T00:10:00.000Z'],
    ['2026-02-28T05:00:00.000Z', '03:15', '2026-03-01T03:15:00.000Z'],
  ])('M4-06 K-23 at %s with %s the next run is %s', (now, runUtc, expected) => {
    expect(nextRunAt(new Date(now), runUtc).toISOString()).toBe(expected);
  });

  it.each(['0:10', '24:00', '00:60', '', '00:10:00', 'ab:cd', ' 00:10'])(
    'M4-06 K-23 refuses the time %j',
    (runUtc) => {
      expect(() => nextRunAt(new Date('2026-10-06T00:00:00Z'), runUtc)).toThrow(RangeError);
    },
  );

  it('M4-06 K-23 refuses an invalid instant', () => {
    expect(() => nextRunAt(new Date('nope'), '00:10')).toThrow(RangeError);
  });
});

describe('M4-06 K-23 the run reconciles the date before (the job itself is tested with the scheduler, M4-10)', () => {
  it.each([
    ['2026-10-06T00:10:00.000Z', '2026-10-05'],
    ['2026-01-01T00:10:00.000Z', '2025-12-31'],
    ['2026-03-01T00:10:00.000Z', '2026-02-28'],
    ['2026-10-06T23:59:59.999Z', '2026-10-05'],
  ])('M4-06 K-23 at %s the date is %s', (now, expected) => {
    expect(previousDate(new Date(now))).toBe(expected);
  });
});
