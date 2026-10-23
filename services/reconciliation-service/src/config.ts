import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  modeConfigShape,
  pgConfigSchema,
  privacyUrlMatchesMode,
  readSecret,
  runTimeUtc,
  schedulerConfigShape,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';

// Addresses of the other processes come from configuration only (API7): no caller names a URL.
const serviceUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.hostname });

/**
 * What the reconciliation service reads from the environment, on top of the shared bootstrap (spec reconciliation 3.2,
 * K-23). No default for the run time: a missing value stops the start (fail fast). The database password and the client
 * secret at the IdP are files named by `<NAME>_FILE`, not values here.
 */
export const reconciliationConfigSchema = z
  .object({
    ...modeConfigShape,
    ...pgConfigSchema.shape,
    ...httpConfigSchema.shape,
    ...idpConfigShape,
    ...schedulerConfigShape,
    // K-23: the daily run, as HH:MM in UTC.
    RECON_DAILY_RUN_UTC: runTimeUtc,
    // ADR-0006: only proposed has a Privacy to call; baseline with an address, or proposed without one, does not start.
    PRIVACY_SERVICE_URL: serviceUrl.optional(),
    TRANSACTION_SERVICE_URL: serviceUrl,
  })
  .superRefine(privacyUrlMatchesMode);
export type ReconciliationConfig = z.output<typeof reconciliationConfigSchema>;

export const loadReconciliationConfig = (env: EnvSource): ReconciliationConfig =>
  loadConfig(reconciliationConfigSchema, env);

/** The client secret at the IdP, read from the file named by `RECONCILIATION_CLIENT_SECRET_FILE` (fail fast). */
export const readClientSecret = (env: EnvSource): string =>
  readSecret(env, 'RECONCILIATION_CLIENT_SECRET');
