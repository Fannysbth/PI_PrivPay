import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  pgConfigSchema,
  runTimeUtc,
  schedulerConfigShape,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';

const seconds = z.coerce.number().int().positive();

/**
 * What the privacy service reads from the environment, on top of the shared bootstrap (spec privacy 3, PRD 17). No
 * default for a TTL or the grace period: a missing value stops the start (fail fast). The three keys and the role
 * passwords are files named by `<NAME>_FILE`, read by `loadKeys` and `createPool`, not values here.
 */
export const privacyConfigSchema = z.object({
  ...pgConfigSchema.shape,
  ...httpConfigSchema.shape,
  ...idpConfigShape,
  ...schedulerConfigShape,
  GRACE_PERIOD_SECONDS: z.coerce.number().int().min(0),
  PSEUDONYM_KEY_VERSION: z.coerce.number().int().min(1).max(65_535),
  TTL_PAYMENT_PROCESSING: seconds,
  TTL_FRAUD_DETECTION: seconds,
  TTL_NOTIFICATION: seconds,
  TTL_NOTIFICATION_REGISTRATION: seconds,
  TTL_DAILY_RECONCILIATION: seconds,
  TTL_INTERNAL_AUDIT: seconds,
  // PRD 17: how long an approved disclosure can be used (600 s); no default, like the TTLs.
  DISCLOSURE_APPROVAL_TTL_SECONDS: seconds,
  // PRD 17, K-26: how long an expired token keeps its identity (90 days for this research) and when the job that empties
  // it runs each day; no default, like the TTLs.
  RETENTION_DAYS: z.coerce.number().int().min(1),
  RETENTION_JOB_RUN_UTC: runTimeUtc,
});
export type PrivacyConfig = z.output<typeof privacyConfigSchema>;

export const loadPrivacyConfig = (env: EnvSource): PrivacyConfig =>
  loadConfig(privacyConfigSchema, env);
