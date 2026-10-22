import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  pgConfigSchema,
  readSecret,
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
export const reconciliationConfigSchema = z.object({
  ...pgConfigSchema.shape,
  ...httpConfigSchema.shape,
  ...idpConfigShape,
  // K-23: the daily run, as HH:MM in UTC.
  RECON_DAILY_RUN_UTC: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  PRIVACY_SERVICE_URL: serviceUrl,
  TRANSACTION_SERVICE_URL: serviceUrl,
});
export type ReconciliationConfig = z.output<typeof reconciliationConfigSchema>;

export const loadReconciliationConfig = (env: EnvSource): ReconciliationConfig =>
  loadConfig(reconciliationConfigSchema, env);

/** The client secret at the IdP, read from the file named by `RECONCILIATION_CLIENT_SECRET_FILE` (fail fast). */
export const readClientSecret = (env: EnvSource): string =>
  readSecret(env, 'RECONCILIATION_CLIENT_SECRET');
