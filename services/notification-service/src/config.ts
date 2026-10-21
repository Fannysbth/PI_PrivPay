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
 * What the notification service reads from the environment, on top of the shared bootstrap (spec notification 3). The
 * database password and the client secret at the IdP are not here: they are files named by `<NAME>_FILE` (CLAUDE.md,
 * secrets), read by `createPool` and `loadNotificationConfig`.
 */
export const notificationConfigSchema = z.object({
  ...pgConfigSchema.shape,
  ...httpConfigSchema.shape,
  ...idpConfigShape,
  PRIVACY_SERVICE_URL: serviceUrl,
  SMS_SIMULATOR_URL: serviceUrl,
});
export type NotificationConfig = z.output<typeof notificationConfigSchema>;

export function loadNotificationConfig(
  env: EnvSource,
): NotificationConfig & { clientSecret: string } {
  const config = loadConfig(notificationConfigSchema, env);
  return { ...config, clientSecret: readSecret(env, 'NOTIFICATION_CLIENT_SECRET') };
}
