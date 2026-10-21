import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  pgConfigSchema,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';

/**
 * What the transaction service reads from the environment, on top of the shared bootstrap (spec transaction, PRD 17).
 * No default for the fraud threshold: a missing value stops the start (fail fast). The database password is a file
 * named by `<NAME>_FILE`, read by `createPool`, not a value here.
 */
export const transactionConfigSchema = z.object({
  ...pgConfigSchema.shape,
  ...httpConfigSchema.shape,
  ...idpConfigShape,
  // PRD 17: an amount under it is completed without asking Fraud; at or over it, Fraud decides.
  FRAUD_AMOUNT_THRESHOLD: z.coerce.number().int().min(1),
});
export type TransactionConfig = z.output<typeof transactionConfigSchema>;

export const loadTransactionConfig = (env: EnvSource): TransactionConfig =>
  loadConfig(transactionConfigSchema, env);
