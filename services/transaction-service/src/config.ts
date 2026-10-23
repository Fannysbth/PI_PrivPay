import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  modeConfigShape,
  pgConfigSchema,
  privacyUrlMatchesMode,
  schedulerConfigShape,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';

// Addresses of the other processes come from configuration only (API7): no caller names a URL.
const serviceUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.hostname });

/**
 * What the transaction service reads from the environment, on top of the shared bootstrap (spec transaction, PRD 17).
 * No default for the fraud threshold: a missing value stops the start (fail fast). The database password is a file
 * named by `<NAME>_FILE`, read by `createPool`, not a value here.
 */
export const transactionConfigSchema = z
  .object({
    ...modeConfigShape,
    ...pgConfigSchema.shape,
    ...httpConfigSchema.shape,
    ...idpConfigShape,
    ...schedulerConfigShape,
    // PRD 17: an amount under it is completed without asking Fraud; at or over it, Fraud decides.
    FRAUD_AMOUNT_THRESHOLD: z.coerce.number().int().min(1),
    // PRD 17: a PENDING row older than this is failed by the sweeper (spec transaction 5, step 6).
    TX_PENDING_TIMEOUT_SECONDS: z.coerce.number().int().min(1),
    // K-19: how often the cleaner runs (fail PENDING rows past the timeout, repeat the PATCH Privacy has not heard).
    TX_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(1),
    // ADR-0006: only proposed has a Privacy to call; baseline with an address, or proposed without one, does not start.
    PRIVACY_SERVICE_URL: serviceUrl.optional(),
    FRAUD_SERVICE_URL: serviceUrl,
    NOTIFICATION_SERVICE_URL: serviceUrl,
  })
  .superRefine(privacyUrlMatchesMode);
export type TransactionConfig = z.output<typeof transactionConfigSchema>;

export const loadTransactionConfig = (env: EnvSource): TransactionConfig =>
  loadConfig(transactionConfigSchema, env);
