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
    // DK-02b: true when Kong replaces the identifiers by tokens before the adapter (proposed only). The adapter then
    // takes the tokenized shape from Kong, which proves itself with EDGE_ADAPTER_SECRET_FILE, and never raw identifiers.
    EDGE_TOKENIZATION: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine(privacyUrlMatchesMode)
  .superRefine((config, ctx) => {
    // Without a Privacy Service nothing is tokenized, so there is nothing for Kong to do and nothing to trust it for.
    if (config.EDGE_TOKENIZATION && config.PRIVACY_SERVICE_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['EDGE_TOKENIZATION'],
        message: 'needs a Privacy Service (PRIVACY_SERVICE_URL)',
      });
    }
  });
export type GatewayConfig = z.output<typeof gatewayConfigSchema>;

export interface KeycloakAdminSecrets {
  readonly adminClientSecret: string;
  readonly userPassword: string;
}

export function loadGatewayConfig(env: EnvSource): GatewayConfig & {
  clientSecret: string;
  edgeSecret: string | undefined;
  keycloakAdmin: KeycloakAdminSecrets | undefined;
} {
  const config = loadConfig(gatewayConfigSchema, env);
  return {
    ...config,
    clientSecret: readSecret(env, 'API_GATEWAY_CLIENT_SECRET'),
    // ADR-0017 items 5 and 6: only the registration at Keycloak needs the Admin API client and the one test password.
    keycloakAdmin:
      config.IDP_KIND === 'keycloak'
        ? {
            adminClientSecret: readSecret(env, 'IDP_ADMIN_CLIENT_SECRET'),
            userPassword: readSecret(env, 'IDP_USER_PASSWORD'),
          }
        : undefined,
    edgeSecret: config.EDGE_TOKENIZATION ? readSecret(env, 'EDGE_ADAPTER_SECRET') : undefined,
  };
}
