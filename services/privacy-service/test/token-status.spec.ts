import { FakeClock } from '@privpay/common';
import { effectiveStatus } from '../src/token';

// Seam: effectiveStatus, pure, with FakeClock (qa C-01). Spec privacy 7.1: revoked and expired stay; after expires_at
// plus the grace period a token is expired; between them it is in grace (accepts operations already under way, never
// a new issue); otherwise active. Boundaries are exact, to the millisecond.
const EXPIRES = new Date('2026-10-20T08:15:00.000Z');
const GRACE = 30;
const at = (offsetMs: number): Date => new Date(EXPIRES.getTime() + offsetMs);

describe('M2-05 C-01 effectiveStatus', () => {
  it.each([
    ['well before expiry', -900_000, 'active'],
    ['one millisecond before expiry', -1, 'active'],
    ['exactly at expires_at', 0, 'active'],
    ['one millisecond after expires_at', 1, 'grace'],
    ['inside the grace period', 15_000, 'grace'],
    ['exactly at expires_at + grace', 30_000, 'grace'],
    ['one millisecond after expires_at + grace', 30_001, 'expired'],
    ['long after', 86_400_000, 'expired'],
  ])('M2-05 C-01 an active row %s is %s', (_name, offsetMs, expected) => {
    const clock = new FakeClock(at(offsetMs));
    expect(effectiveStatus({ status: 'active', expiresAt: EXPIRES }, clock.now(), GRACE)).toBe(
      expected,
    );
  });

  it('M2-05 C-01 revoked and expired rows keep their status whatever the time', () => {
    for (const offsetMs of [-900_000, 0, 15_000, 86_400_000]) {
      const now = at(offsetMs);
      expect(effectiveStatus({ status: 'revoked', expiresAt: EXPIRES }, now, GRACE)).toBe(
        'revoked',
      );
      expect(effectiveStatus({ status: 'expired', expiresAt: EXPIRES }, now, GRACE)).toBe(
        'expired',
      );
    }
  });

  it('M2-05 C-01 a grace period of zero leaves no grace', () => {
    expect(effectiveStatus({ status: 'active', expiresAt: EXPIRES }, at(0), 0)).toBe('active');
    expect(effectiveStatus({ status: 'active', expiresAt: EXPIRES }, at(1), 0)).toBe('expired');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'M2-05 C-01 refuses a grace period of %s',
    (grace) => {
      expect(() => effectiveStatus({ status: 'active', expiresAt: EXPIRES }, at(0), grace)).toThrow(
        RangeError,
      );
    },
  );

  it('M2-05 C-01 an unknown stored status is not treated as active', () => {
    const odd = { status: 'pending', expiresAt: EXPIRES } as never;
    expect(() => effectiveStatus(odd, at(0), GRACE)).toThrow(RangeError);
  });
});
