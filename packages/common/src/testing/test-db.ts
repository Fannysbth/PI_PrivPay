import { Client, Pool } from 'pg';
import {
  assertPrivpayName,
  createPool,
  readRolePassword,
  SERVICE_DBS,
  type PgConfig,
  type ServiceName,
} from '../db';

export const TEST_ADMIN_ROLE = 'privpay_test_admin';

const SUFFIX = /^[a-z0-9]{1,20}$/;

export interface TestDb {
  readonly database: string;
  /** Schema owner: what the migration runner uses. */
  readonly owner: Pool;
  /** The real runtime role of the service. */
  readonly app: Pool;
  /** The read-only audit role (Privacy only). */
  readonly auditor?: Pool;
  /** Ends the pools. The database itself is recreated by the next `createTestDb`. */
  close(): Promise<void>;
}

/** The test admin's maintenance connection (database `postgres`), for checks that span databases. */
export function createAdminPool(config: PgConfig): Pool {
  return new Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: TEST_ADMIN_ROLE,
    password: readRolePassword(config.PG_SECRETS_DIR, TEST_ADMIN_ROLE),
    database: 'postgres',
    max: 2,
  });
}

/** `privpay_<service>_test_<suffix>`: one database per test file, so files can run side by side. */
export function testDatabaseName(service: ServiceName, suffix: string): string {
  if (!SUFFIX.test(suffix))
    throw new RangeError('suffix must be 1 to 20 lowercase letters or digits');
  return `${SERVICE_DBS[service].database}_test_${suffix}`;
}

/**
 * Recreates a clean test database owned by the service's schema owner (by `privpay_test_admin`, which is neither a
 * superuser nor able to touch anything outside the privpay_ namespace), optionally applies `schema` as the owner,
 * and returns pools that connect as the real roles, so grants and revokes are tested for real.
 */
export async function createTestDb(
  config: PgConfig,
  options: { service: ServiceName; suffix: string; schema?: string },
): Promise<TestDb> {
  const { owner, app, auditor } = SERVICE_DBS[options.service];
  const database = testDatabaseName(options.service, options.suffix);
  assertPrivpayName(database);
  const runtimeRoles = auditor === undefined ? [app] : [app, auditor];

  const admin = new Client({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: TEST_ADMIN_ROLE,
    password: readRolePassword(config.PG_SECRETS_DIR, TEST_ADMIN_ROLE),
    database: 'postgres',
  });
  await admin.connect();
  try {
    // DDL cannot take bind parameters: the names are validated above and quoted here.
    const quoted = admin.escapeIdentifier(database);
    await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoted} OWNER ${admin.escapeIdentifier(owner)}`);
    await admin.query(`REVOKE ALL ON DATABASE ${quoted} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quoted} TO ${runtimeRoles.map((r) => admin.escapeIdentifier(r)).join(', ')}`,
    );
  } finally {
    await admin.end();
  }

  const pools: Pool[] = [];
  const open = (role: string, max: number): Pool => {
    const pool = createPool(config, { role, database, max });
    pools.push(pool);
    return pool;
  };
  const ownerPool = open(owner, 4);
  const close = async (): Promise<void> => {
    await Promise.all(pools.map((pool) => pool.end()));
  };

  try {
    await ownerPool.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await ownerPool.query(
      `GRANT USAGE ON SCHEMA public TO ${runtimeRoles.map((r) => `"${r}"`).join(', ')}`,
    );
    if (options.schema !== undefined) await ownerPool.query(options.schema);
  } catch (error) {
    await close();
    throw error;
  }

  const result = { database, owner: ownerPool, app: open(app, 10), close };
  return auditor === undefined ? result : { ...result, auditor: open(auditor, 4) };
}
