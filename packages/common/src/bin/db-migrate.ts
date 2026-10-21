import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { createPool, pgConfigSchema, SERVICE_DBS, type ServiceName } from '../db';
import { migrateServices, SERVICE_FOLDERS } from '../db-migrate';
import { PRIVACY_MODES } from '../mode';

// `pnpm db:migrate [service]`: creates or updates the tables of the service databases as their schema owners. Host,
// port, mode and secrets directory come from the environment like the tests (PG_HOST, PG_PORT, PG_SECRETS_DIR,
// PRIVACY_MODE; `.env.test`). Forward only; it never drops anything.
async function main(): Promise<number> {
  const config = loadConfig(pgConfigSchema, process.env);
  // Only the proposed condition has tables so far (spec data 2), so an unset mode means that; a wrong one is an error.
  const wanted = process.env['PRIVACY_MODE'] ?? 'proposed';
  const mode = PRIVACY_MODES.find((candidate) => candidate === wanted);
  if (mode === undefined) throw new Error('PRIVACY_MODE must be baseline or proposed');
  const only = process.argv[2];
  const services = (Object.keys(SERVICE_FOLDERS) as ServiceName[]).filter(
    (service) => only === undefined || service === only,
  );
  if (services.length === 0) throw new Error('unknown service');
  const pools: Pool[] = [];
  try {
    await migrateServices({
      repoRoot: process.cwd(),
      mode,
      services,
      openOwner: (service) => {
        const pool = createPool(config, {
          role: SERVICE_DBS[service].owner,
          database: SERVICE_DBS[service].database,
          max: 1,
        });
        pools.push(pool);
        return pool;
      },
      out: (line) => process.stdout.write(`${line}\n`),
    });
    return 0;
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A category only: a connection error could carry the host or a role name, a migration error names a file.
    const name = (error as { name?: unknown } | null)?.name;
    const reason = (error as { reason?: unknown } | null)?.reason;
    process.stderr.write(
      `db:migrate failed: ${typeof reason === 'string' ? reason : typeof name === 'string' ? name : 'error'}\n`,
    );
    process.exitCode = 1;
  },
);
