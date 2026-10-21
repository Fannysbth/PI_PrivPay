import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  readSecret,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';

// Addresses of the other processes come from configuration only (API7): the client never names a URL.
const serviceUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.hostname });

/**
 * What the gateway reads from the environment, on top of the shared bootstrap (platform spec 6, PRD 17). The client
 * secret is not here: it is a file named by API_GATEWAY_CLIENT_SECRET_FILE (CLAUDE.md, secrets).
 */
export const gatewayConfigSchema = z.object({
  ...httpConfigSchema.shape,
  ...idpConfigShape,
  PRIVACY_SERVICE_URL: serviceUrl,
  TRANSACTION_SERVICE_URL: serviceUrl,
  RECONCILIATION_SERVICE_URL: serviceUrl,
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(100),
});
export type GatewayConfig = z.output<typeof gatewayConfigSchema>;

export function loadGatewayConfig(env: EnvSource): GatewayConfig & { clientSecret: string } {
  const config = loadConfig(gatewayConfigSchema, env);
  return { ...config, clientSecret: readSecret(env, 'API_GATEWAY_CLIENT_SECRET') };
}
