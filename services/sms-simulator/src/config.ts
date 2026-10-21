import { idpConfigShape, loadConfig, type EnvSource } from '@privpay/common';
import { z } from 'zod';

// Only the exact word turns a switch on: "TRUE", "1" or an empty value leave it off (a test endpoint must be asked for).
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/**
 * What the SMS simulator reads from the environment (spec notification 4, K-21). Both switches are off unless set:
 * the endpoints that read the messages exist only in the test environment, and the failure is only injected there.
 */
export const smsSimulatorConfigSchema = z.object({
  ...idpConfigShape,
  SMS_SIMULATOR_TEST_ENDPOINTS: flag,
  SMS_SIMULATOR_FAIL: flag,
});
export type SmsSimulatorConfig = z.output<typeof smsSimulatorConfigSchema>;

export const loadSmsSimulatorConfig = (env: EnvSource): SmsSimulatorConfig =>
  loadConfig(smsSimulatorConfigSchema, env);
