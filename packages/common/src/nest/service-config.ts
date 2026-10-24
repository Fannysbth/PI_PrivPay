import { z } from 'zod';
import { PRIVACY_MODES } from '../mode';

/** The services that run in the local phase (platform spec 8). `auth` is the dev IdP and has its own entry. */
export const SERVICE_IDS = [
  'gateway',
  'privacy-service',
  'transaction-service',
  'fraud-service',
  'notification-service',
  'reconciliation-service',
  'bank-simulator',
  'sms-simulator',
] as const;
/** Processes under tools/ that use the same bootstrap but are not platform services (ADR-0004). */
export const TOOL_IDS = ['dev-idp'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number] | (typeof TOOL_IDS)[number];

/**
 * What every service reads from the environment. The bind address defaults to loopback (AZ-43). `0.0.0.0` is accepted
 * only when set explicitly: a container must listen on its network interface to be reached by its neighbours (DK-01a,
 * decision of 2026-10-24); the Compose network is then the boundary, and only the Gateway is published, to the host's
 * loopback. Any other address is refused. UTC is mandatory (NFR-20).
 */
export const serviceConfigSchema = z.object({
  PRIVACY_MODE: z.enum(PRIVACY_MODES),
  PORT: z.coerce.number().int().min(0).max(65535),
  BIND_HOST: z.enum(['127.0.0.1', '::1', '0.0.0.0']).default('127.0.0.1'),
  TZ: z.literal('UTC').default('UTC'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});
export type ServiceConfig = z.output<typeof serviceConfigSchema>;
