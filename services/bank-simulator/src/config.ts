import { httpConfigSchema, idpConfigShape, loadConfig, type EnvSource } from '@privpay/common';
import { z } from 'zod';

// Addresses of the other processes come from configuration only (API7): no caller names a URL.
const serviceUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.hostname });

// Only the exact word turns the switch on: "TRUE", "1" or an empty value stop the start (a test endpoint must be asked for).
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/**
 * What the bank simulator reads from the environment (spec reconciliation 4). It has no secret: in the local phase the
 * bank user signs in at the dev IdP by name (tools/dev-idp), so there is nothing to keep out of the repository. The
 * endpoint that starts a report exists only when `BANK_SIMULATOR_TEST_ENDPOINTS=true` (AZ-40).
 */
export const bankSimulatorConfigSchema = z.object({
  ...httpConfigSchema.shape,
  ...idpConfigShape,
  GATEWAY_URL: serviceUrl,
  BANK_USERNAME: z.string().regex(/^[a-z0-9._-]{1,64}$/),
  BANK_SIMULATOR_TEST_ENDPOINTS: flag,
});
export type BankSimulatorConfig = z.output<typeof bankSimulatorConfigSchema>;

export const loadBankSimulatorConfig = (env: EnvSource): BankSimulatorConfig =>
  loadConfig(bankSimulatorConfigSchema, env);
