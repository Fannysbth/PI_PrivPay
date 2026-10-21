import { join } from 'node:path';
import {
  ConfigError,
  loadConfig,
  readSecret,
  type ConfigIssue,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';
import { SERVICE_CLIENTS, type ServiceClient } from './registry';

/**
 * The dev IdP only starts when it was asked for and the process is not production: a fake issuer must never be
 * reachable where real tokens are expected (ADR-0004, NFR-21). The bind address is limited to loopback by the shared
 * bootstrap.
 */
export const devIdpConfigSchema = z.object({
  DEV_IDP_ENABLED: z.literal('true'),
  // Named, and local: an unset or unknown NODE_ENV is not proof of a local phase, so only development and test pass
  // (case and spaces ignored: 'Production' is production). A deployment that forgot to set it fails instead of running.
  NODE_ENV: z
    .string()
    .refine((value) => ['development', 'test'].includes(value.trim().toLowerCase())),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
  DEV_IDP_SECRETS_DIR: z.string().min(1).default('./secrets'),
});
export type DevIdpConfig = z.output<typeof devIdpConfigSchema>;

export function loadDevIdpConfig(env: EnvSource): DevIdpConfig {
  return loadConfig(devIdpConfigSchema, env);
}

const MIN_SECRET_LENGTH = 16;

/**
 * Reads `<dir>/<client>_client_secret` for every service account (platform spec 12). All problems are reported
 * together, by variable name; no path and no value is repeated.
 */
export function readServiceSecrets(dir: string): Record<ServiceClient, string> {
  const secrets = {} as Record<ServiceClient, string>;
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  for (const client of SERVICE_CLIENTS) {
    const name = `${client.toUpperCase().replaceAll('-', '_')}_CLIENT_SECRET`;
    try {
      const value = readSecret({ [`${name}_FILE`]: join(dir, `${client}_client_secret`) }, name);
      // A short or shared secret is not worth the check that follows it.
      if (value.length < MIN_SECRET_LENGTH || seen.has(value)) {
        issues.push({ name: `${name}_FILE`, problem: 'invalid' });
        continue;
      }
      seen.add(value);
      secrets[client] = value;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      issues.push(...error.issues);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return secrets;
}
