import { z } from 'zod';

/** ADR-0003: only two conditions exist. */
export const PRIVACY_MODES = ['baseline', 'proposed'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

/** The mode as a service reads it from its own environment (M5-02): every service declares it, none assumes one. */
export const modeConfigShape = { PRIVACY_MODE: z.enum(PRIVACY_MODES) } as const;

/**
 * ADR-0006: the baseline adapters hold real identities, so they are built only when the process runs in baseline. A
 * configuration of the proposed mode that reaches one is a mistake that must stop the process, not a quiet fallback.
 */
export function assertBaselineMode(mode: PrivacyMode): void {
  if (mode !== 'baseline') {
    throw new Error('baseline adapters need PRIVACY_MODE=baseline: they hold real identities');
  }
}

/**
 * N-44: how a reference to a subject looks at the edge of a service. In proposed it is a token for a customer and for an
 * account; in baseline it is the identifier itself (spec data 9). Services validate with the shape of their mode, so the
 * check of the HTTP edge exists in both modes and only the accepted form differs.
 */
export const SUBJECT_REF_SHAPES = {
  proposed: { customer: /^PSEU-[0-9A-F]{8}$/, account: /^PSEU-[0-9A-F]{8}$/ },
  baseline: { customer: /^CUST-[0-9]{6}$/, account: /^[0-9]{8,20}$/ },
} as const satisfies Record<PrivacyMode, { customer: RegExp; account: RegExp }>;

export const subjectRefShape = (mode: PrivacyMode): (typeof SUBJECT_REF_SHAPES)[PrivacyMode] =>
  SUBJECT_REF_SHAPES[mode];

/**
 * ADR-0006: the address of Privacy Service belongs to proposed only. A baseline process that is still pointed at Privacy
 * is a half-switched configuration (it would look like it keeps Privacy in the loop), and a proposed one without it
 * cannot work; both stop the start. Used as `schema.superRefine(privacyUrlMatchesMode)` on the config of a service.
 */
export function privacyUrlMatchesMode(
  config: { readonly PRIVACY_MODE: PrivacyMode; readonly PRIVACY_SERVICE_URL?: string | undefined },
  ctx: z.core.$RefinementCtx,
): void {
  const present = config.PRIVACY_SERVICE_URL !== undefined;
  if (config.PRIVACY_MODE === 'proposed' && !present) {
    ctx.addIssue({
      code: 'custom',
      path: ['PRIVACY_SERVICE_URL'],
      message: 'required in proposed',
    });
  }
  if (config.PRIVACY_MODE === 'baseline' && present) {
    ctx.addIssue({
      code: 'custom',
      path: ['PRIVACY_SERVICE_URL'],
      message: 'not allowed in baseline',
    });
  }
}
