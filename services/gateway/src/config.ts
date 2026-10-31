import {
  httpConfigSchema,
  idpConfigShape,
  loadConfig,
  modeConfigShape,
  privacyUrlMatchesMode,
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
export const gatewayConfigSchema = z
  .object({
    ...modeConfigShape,
    ...httpConfigSchema.shape,
    ...idpConfigShape,
    // ADR-0006: only proposed has a Privacy to call; baseline with an address, or proposed without one, does not start.
    PRIVACY_SERVICE_URL: serviceUrl.optional(),
    TRANSACTION_SERVICE_URL: serviceUrl,
    RECONCILIATION_SERVICE_URL: serviceUrl,
    NOTIFICATION_SERVICE_URL: serviceUrl,
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(100),
    // DK-02a: 1 when Kong is the one proxy in front (its X-Forwarded-For entry is believed); 0 otherwise.
    EDGE_PROXY_HOPS: z.enum(['0', '1']).default('0').transform(Number),
  })
  .superRefine(privacyUrlMatchesMode);
export type GatewayConfig = z.output<typeof gatewayConfigSchema>;

export function loadGatewayConfig(env: EnvSource): GatewayConfig & { clientSecret: string } {
  const config = loadConfig(gatewayConfigSchema, env);
  return { ...config, clientSecret: readSecret(env, 'API_GATEWAY_CLIENT_SECRET') };
}
