import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate } from './migrate';
import type { PrivacyMode } from './mode';
import type { ServiceName } from './db';

/** The folder of each service under `services/` (the database names are in SERVICE_DBS). */
export const SERVICE_FOLDERS: Readonly<Record<ServiceName, string>> = {
  privacy: 'privacy-service',
  transaction: 'transaction-service',
  fraud: 'fraud-service',
  notification: 'notification-service',
  reconciliation: 'reconciliation-service',
};

export interface MigrateServicesOptions {
  readonly repoRoot: string;
  readonly mode: PrivacyMode;
  /** The schema-owner pool of one service database. The caller owns it and ends it. */
  readonly openOwner: (service: ServiceName) => Pool;
  readonly services?: readonly ServiceName[];
  readonly out?: (line: string) => void;
}

/**
 * Brings the database of each service up to date with its migration files (`pnpm db:migrate`). Forward only and
 * idempotent: what is applied is recorded and checked by `migrate`, so a second run applies nothing and an edited file
 * is refused. A service without a `migrations` folder yet is skipped. It never drops or empties anything.
 */
export async function migrateServices(options: MigrateServicesOptions): Promise<void> {
  const out = options.out ?? (() => undefined);
  const services = options.services ?? (Object.keys(SERVICE_FOLDERS) as ServiceName[]);
  for (const service of services) {
    const root = join(options.repoRoot, 'services', SERVICE_FOLDERS[service], 'migrations');
    if (!existsSync(root)) {
      out(`${service}: no migrations yet, skipped`);
      continue;
    }
    const { applied } = await migrate(options.openOwner(service), { root, mode: options.mode });
    out(
      applied.length === 0 ? `${service}: up to date` : `${service}: applied ${applied.join(', ')}`,
    );
  }
}
