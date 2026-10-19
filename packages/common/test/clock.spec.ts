import { FakeClock, SystemClock } from '../src/clock';

describe('M0-02 clock is injectable and always UTC (NFR-20)', () => {
  it('M0-02 SystemClock returns the current instant as a Date', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('M0-02 FakeClock starts at the given instant and advances by exact seconds', () => {
    const clock = new FakeClock('2026-10-05T12:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-05T12:00:00.000Z');
    clock.advance(901);
    expect(clock.now().toISOString()).toBe('2026-10-05T12:15:01.000Z');
  });

  it('M0-02 FakeClock can be set to another instant', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    clock.set('2026-10-06T00:10:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-06T00:10:00.000Z');
  });

  it('M0-02 FakeClock hands out copies so callers cannot move time by mutating a Date', () => {
    const clock = new FakeClock('2026-10-05T12:00:00Z');
    clock.now().setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  it('M0-02 FakeClock refuses an instant without a time zone because it would be read as local time', () => {
    expect(() => new FakeClock('2026-01-01T00:00:00')).toThrow(RangeError);
    expect(new FakeClock('2026-01-01T00:00:00+07:00').now().toISOString()).toBe(
      '2025-12-31T17:00:00.000Z',
    );
  });

  it('M0-02 FakeClock refuses to advance by a non-finite amount', () => {
    const clock = new FakeClock('2026-10-05T12:00:00Z');
    expect(() => {
      clock.advance(Number.NaN);
    }).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  it('M0-02 FakeClock rejects an invalid instant', () => {
    expect(() => new FakeClock('not a date')).toThrow();
  });
});
