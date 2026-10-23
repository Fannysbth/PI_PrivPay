import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  modeConfigShape,
  pgConfigSchema,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';

const hour = z.coerce.number().int().min(0).max(23);

/**
 * What the fraud service reads from the environment, on top of the shared bootstrap (spec fraud 4, PRD 17). No default
 * for a threshold or an hour: a missing value stops the start (fail fast). The database password is a file named by
 * `<NAME>_FILE`, read by `createPool`, not a value here.
 */
export const fraudConfigSchema = z
  .object({
    ...modeConfigShape,
    ...pgConfigSchema.shape,
    ...httpConfigSchema.shape,
    ...idpConfigShape,
    FRAUD_AMOUNT_THRESHOLD: z.coerce.number().int().min(1),
    FRAUD_ODD_HOUR_START: hour,
    FRAUD_ODD_HOUR_END: hour,
    // K-20: the score from which a transaction is held, and from which it is blocked.
    FRAUD_HOLD_THRESHOLD: z.coerce.number().int().min(1),
    FRAUD_BLOCK_THRESHOLD: z.coerce.number().int().min(1),
    // N-45 (PRD 10): how many days back the history reaches, the same in both modes.
    // The upper bound keeps `now - days` a valid date; ten years is far beyond what the research uses.
    FRAUD_HISTORY_DAYS: z.coerce.number().int().min(1).max(3650),
  })
  .refine((config) => config.FRAUD_HOLD_THRESHOLD < config.FRAUD_BLOCK_THRESHOLD, {
    path: ['FRAUD_HOLD_THRESHOLD'],
    message: 'must be under FRAUD_BLOCK_THRESHOLD',
  })
  // The night runs from START round midnight to END (22 to 6). Any other order would fire the rule for every hour.
  .refine((config) => config.FRAUD_ODD_HOUR_END < config.FRAUD_ODD_HOUR_START, {
    path: ['FRAUD_ODD_HOUR_END'],
    message: 'must be under FRAUD_ODD_HOUR_START',
  });
export type FraudConfig = z.output<typeof fraudConfigSchema>;

export const loadFraudConfig = (env: EnvSource): FraudConfig => loadConfig(fraudConfigSchema, env);
