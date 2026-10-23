import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { PrivacyPort } from '../tokenizer/privacy-port';
import { PassthroughPrivacyPort } from './passthrough-privacy-port';

/** ADR-0006: the port of the baseline mode, which hands the identity on. Refused unless the mode is baseline. */
export function baselinePrivacyPort(mode: PrivacyMode): PrivacyPort {
  assertBaselineMode(mode);
  return new PassthroughPrivacyPort();
}
