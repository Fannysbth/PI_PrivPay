export type StoredStatus = 'active' | 'expired' | 'revoked';
export type EffectiveStatus = 'active' | 'grace' | 'expired' | 'revoked';

const STORED: readonly string[] = ['active', 'expired', 'revoked'];

/**
 * status_efektif (spec privacy 7.1, PRD 6.2): revoked and expired stay what they are; an active row past `expires_at`
 * plus the grace period is expired; between the two it is in grace, which still accepts an operation already under
 * way but never a new issue (buat_token marks an active row expired as soon as `expires_at` has passed). The
 * boundaries are exact: at `expires_at` the row is still active, at `expires_at + grace` still in grace.
 */
export function effectiveStatus(
  mapping: { readonly status: StoredStatus; readonly expiresAt: Date },
  now: Date,
  graceSeconds: number,
): EffectiveStatus {
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
    throw new RangeError('the grace period must be a non-negative number of seconds');
  }
  if (!STORED.includes(mapping.status)) throw new RangeError('unknown stored token status');
  if (mapping.status !== 'active') return mapping.status;
  const expires = mapping.expiresAt.getTime();
  const at = now.getTime();
  if (at > expires + graceSeconds * 1000) return 'expired';
  return at > expires ? 'grace' : 'active';
}
