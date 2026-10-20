import { nextRunAt } from '../src/retention';

// Seam: nextRunAt, pure. K-26: the retention job runs daily at RETENTION_JOB_RUN_UTC ("HH:MM", UTC, default 01:00).
// It returns the first such instant strictly after `now`: a job that has just run at that minute waits for tomorrow.
describe('M2-09 K-26 nextRunAt', () => {
  it.each([
    ['2026-10-20T00:30:00.000Z', '01:00', '2026-10-20T01:00:00.000Z'],
    ['2026-10-20T00:59:59.999Z', '01:00', '2026-10-20T01:00:00.000Z'],
    ['2026-10-20T01:00:00.000Z', '01:00', '2026-10-21T01:00:00.000Z'],
    ['2026-10-20T01:00:00.001Z', '01:00', '2026-10-21T01:00:00.000Z'],
    ['2026-10-20T23:59:00.000Z', '01:00', '2026-10-21T01:00:00.000Z'],
    ['2026-12-31T23:30:00.000Z', '00:10', '2027-01-01T00:10:00.000Z'],
    ['2026-10-20T12:00:00.000Z', '23:59', '2026-10-20T23:59:00.000Z'],
    ['2026-02-28T05:00:00.000Z', '03:15', '2026-03-01T03:15:00.000Z'],
  ])('M2-09 K-26 at %s with %s the next run is %s', (now, runUtc, expected) => {
    expect(nextRunAt(new Date(now), runUtc).toISOString()).toBe(expected);
  });

  it.each([
    '1:00',
    '25:00',
    '01:60',
    '24:00',
    '',
    '01:00:00',
    '0100',
    'ab:cd',
    ' 01:00',
    '01:00 ',
    '-1:00',
    '01.00',
  ])('M2-09 K-26 refuses the time %j', (runUtc) => {
    expect(() => nextRunAt(new Date('2026-10-20T00:00:00Z'), runUtc)).toThrow(RangeError);
  });

  it('M2-09 K-26 refuses an invalid instant', () => {
    expect(() => nextRunAt(new Date('nope'), '01:00')).toThrow(RangeError);
  });
});
