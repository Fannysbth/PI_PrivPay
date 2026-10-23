import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { readSecret } from './config';

export type ServiceName = 'privacy' | 'transaction' | 'fraud' | 'notification' | 'reconciliation';

export interface ServiceDb {
  readonly database: string;
  readonly owner: string;
  readonly app: string;
  /** Read-only audit role; only Privacy has one. */
  readonly auditor?: string;
}

/**
 * One database and one owner/runtime role pair per service (invariant 4), all prefixed `privpay_` so they never
 * collide with other databases on a shared server (ADR-0004). Privacy keeps the PRD role names (`privacy_app` and
 * `auditor_role` there; E-22). The runtime role never owns the schema.
 */
export const SERVICE_DBS: Readonly<Record<ServiceName, ServiceDb>> = {
  privacy: {
    database: 'privpay_privacy',
    owner: 'privpay_privacy_owner',
    app: 'privpay_app',
    auditor: 'privpay_auditor',
  },
  transaction: {
    database: 'privpay_transaction',
    owner: 'privpay_transaction_owner',
    app: 'privpay_transaction_app',
  },
  fraud: { database: 'privpay_fraud', owner: 'privpay_fraud_owner', app: 'privpay_fraud_app' },
  notification: {
    database: 'privpay_notification',
    owner: 'privpay_notification_owner',
    app: 'privpay_notification_app',
  },
  reconciliation: {
    database: 'privpay_reconciliation',
    owner: 'privpay_reconciliation_owner',
    app: 'privpay_reconciliation_app',
  },
};

/** The tail of a disposable database name: one per test file, or one per `dev:up` run (N-50). */
export const DATABASE_SUFFIX = /^[a-z0-9]{1,20}$/;

/** Host, port and version are configuration, never literals in code (ADR-0004). */
export const pgConfigSchema = z.object({
  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().min(1).max(65535),
  PG_SECRETS_DIR: z.string().min(1).default('./secrets'),
  /** N-50: unset in every real run. `dev:up` sets it so a mode can run on databases of its own. */
  PG_DATABASE_SUFFIX: z.string().regex(DATABASE_SUFFIX).optional(),
});
export type PgConfig = z.output<typeof pgConfigSchema>;

/**
 * The database a service connects to: its own, or (with a suffix) the `privpay_<service>_test_<suffix>` that
 * `createTestDb` makes. The roles are the service's either way, so no other database becomes reachable (invariant 4).
 */
export function serviceDatabase(service: ServiceName, suffix: string | undefined): string {
  if (suffix === undefined) return SERVICE_DBS[service].database;
  if (!DATABASE_SUFFIX.test(suffix))
    throw new RangeError('suffix must be 1 to 20 lowercase letters or digits');
  return `${SERVICE_DBS[service].database}_test_${suffix}`;
}

/** Only objects in the PrivPay namespace may be touched: other databases on the server are not ours. */
const PRIVPAY_NAME = /^privpay_[a-z0-9_]{1,50}$/;

export function assertPrivpayName(name: string): void {
  if (!PRIVPAY_NAME.test(name)) throw new RangeError('name is outside the privpay_ namespace');
}

export interface PoolOptions {
  readonly role: string;
  readonly database: string;
  readonly max?: number;
  /** How long opening one new connection may take; production keeps the default. */
  readonly connectionTimeoutMillis?: number;
  /** Idle-connection errors are surfaced on the next query; set this to observe them. */
  readonly onError?: (error: Error) => void;
}

/** Reads `<secretsDir>/<role>_password`, the file created for the role by scripts/db/bootstrap.ps1. */
export function readRolePassword(secretsDir: string, role: string): string {
  assertPrivpayName(role);
  return readSecret({ ROLE_PASSWORD_FILE: join(secretsDir, `${role}_password`) }, 'ROLE_PASSWORD');
}

/** A lazy pool for one role on one database; nothing connects until the first query. */
export function createPool(config: PgConfig, options: PoolOptions): Pool {
  assertPrivpayName(options.role);
  assertPrivpayName(options.database);
  const pool = new Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: options.role,
    password: readRolePassword(config.PG_SECRETS_DIR, options.role),
    database: options.database,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
  });
  pool.on('error', options.onError ?? (() => undefined));
  return pool;
}

/** Runs the work in one transaction: COMMIT when it resolves, ROLLBACK (and the original error) when it fails. */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A failed ROLLBACK means the connection is unusable; it is discarded and the original error still wins.
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
