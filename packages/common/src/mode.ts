/** ADR-0003: only two conditions exist. */
export const PRIVACY_MODES = ['baseline', 'proposed'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

/**
 * ADR-0006: the baseline adapters hold real identities, so they are built only when the process runs in baseline. A
 * configuration of the proposed mode that reaches one is a mistake that must stop the process, not a quiet fallback.
 */
export function assertBaselineMode(mode: PrivacyMode): void {
  if (mode !== 'baseline') {
    throw new Error('baseline adapters need PRIVACY_MODE=baseline: they hold real identities');
  }
}
