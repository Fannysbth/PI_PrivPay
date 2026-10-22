import { DomainError, FakeClock } from '@privpay/common';
import { DailyRun, nextRunAt, previousDate } from '../src/reconciliation';
import { recordingLogger } from './fakes';

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

describe('M4-06 K-23 the run reconciles the date before', () => {
  it.each([
    ['2026-10-06T00:10:00.000Z', '2026-10-05'],
    ['2026-01-01T00:10:00.000Z', '2025-12-31'],
    ['2026-03-01T00:10:00.000Z', '2026-02-28'],
    ['2026-10-06T23:59:59.999Z', '2026-10-05'],
  ])('M4-06 K-23 at %s the date is %s', (now, expected) => {
    expect(previousDate(new Date(now))).toBe(expected);
  });

  it('M4-06 K-23 runPrevious runs yesterday, by the injected clock', async () => {
    const dates: string[] = [];
    const clock = new FakeClock('2026-10-06T00:10:00.000Z');
    const daily = new DailyRun({
      service: {
        run: (date) => {
          dates.push(date);
          return Promise.resolve({} as never);
        },
      },
      clock,
      runUtc: '00:10',
      logger: recordingLogger().logger,
    });
    expect(await daily.runPrevious()).toBe('2026-10-05');
    clock.advance(86_400);
    expect(await daily.runPrevious()).toBe('2026-10-06');
    expect(dates).toEqual(['2026-10-05', '2026-10-06']);
    expect(daily.nextRunAt().toISOString()).toBe('2026-10-08T00:10:00.000Z');
  });

  it('M4-06 K-23 a run that fails is logged by reason alone and the next day is not affected', async () => {
    const log = recordingLogger();
    let failing = true;
    const daily = new DailyRun({
      service: {
        run: () =>
          failing
            ? Promise.reject(new DomainError('SERVICE_UNAVAILABLE'))
            : Promise.resolve({} as never),
      },
      clock: new FakeClock('2026-10-06T00:10:00.000Z'),
      runUtc: '00:10',
      logger: log.logger,
    });
    expect(await daily.runPrevious()).toBeUndefined();
    expect(log.entries).toEqual([
      { level: 'warn', event: 'daily_run_failed', fields: { reason: 'SERVICE_UNAVAILABLE' } },
    ]);
    failing = false;
    expect(await daily.runPrevious()).toBe('2026-10-05');
  });
});
