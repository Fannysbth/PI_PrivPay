/** ADR-0003: only two conditions exist. */
export const PRIVACY_MODES = ['baseline', 'proposed'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];
