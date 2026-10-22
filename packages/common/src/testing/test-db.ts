import { Client, Pool } from 'pg';
import { RealDelay, type Delay } from '../delay';
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

/**
 * Starting a PostgreSQL backend on Windows takes seconds when memory is short or a database was just recreated, and a
 * burst (50 parallel requests on a pool of 10) opens ten at once; the 5 s of production would then fail a test that is
 * about something else ("Connection terminated due to connection timeout", seen in M2-09, token-service, M0-04).
 */
const TEST_CONNECT_TIMEOUT_MS = 20_000;

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
  const pool = new Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: TEST_ADMIN_ROLE,
    password: readRolePassword(config.PG_SECRETS_DIR, TEST_ADMIN_ROLE),
    database: 'postgres',
    max: 2,
  });
  // Same reason as in createPool: an idle error must not crash the test process.
  pool.on('error', () => undefined);
  return pool;
}

const NOT_PERMITTED_TO_TERMINATE = '42501';
const DROP_ATTEMPTS = 50;
const DROP_PAUSE_MS = 100;

/**
 * A session the test admin may not end still holds the database after the wait. It is a superuser's (pgAdmin, psql,
 * an IDE) rather than a runtime role's, because those close within milliseconds; `code` stays the SQLSTATE so callers
 * can tell it from other failures.
 */
export class TestDatabaseBusyError extends Error {
  readonly code = NOT_PERMITTED_TO_TERMINATE;
  readonly database: string;

  constructor(database: string) {
    super(
      `database ${database} is held by a session that the test admin may not end (for example pgAdmin or psql ` +
        'connected as a superuser): disconnect it from privpay_* databases and run again',
    );
    this.name = 'TestDatabaseBusyError';
    this.database = database;
  }
}

/**
 * DROP ... WITH (FORCE) ends the sessions of the previous run, but the test admin may only end those of the owner
 * roles. A runtime-role session that `pool.end()` has already closed can still be listed by the server for a few
 * milliseconds, and then FORCE fails with "permission denied to terminate process". That is waited out (at most five
 * seconds) instead of being a test that fails now and then; a session that really stays becomes a
 * `TestDatabaseBusyError` that says so, and any other failure is passed on as it was.
 */
export async function dropWhenFree(
  admin: Client,
  database: string,
  delay: Delay = new RealDelay(),
): Promise<void> {
  // DDL cannot take bind parameters: the name is quoted here, callers pass privpay_ names only.
  const quoted = admin.escapeIdentifier(database);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
      return;
    } catch (error) {
      const retryable = (error as { code?: string }).code === NOT_PERMITTED_TO_TERMINATE;
      if (!retryable) throw error;
      if (attempt === DROP_ATTEMPTS) throw new TestDatabaseBusyError(database);
      await delay.wait(DROP_PAUSE_MS);
    }
  }
}

/** `privpay_<service>_test_<suffix>`: one database per test file, so files can run side by side. */
export function testDatabaseName(service: ServiceName, suffix: string): string {
  if (!SUFFIX.test(suffix))
    throw new RangeError('suffix must be 1 to 20 lowercase letters or digits');
  return `${SERVICE_DBS[service].database}_test_${suffix}`;
}

/**
 * Recreates a clean test database owned by the service's schema owner (by `privpay_test_admin`, which is not a
 * superuser; it may create databases, so the privpay_ guard above is the only limit), optionally applies `schema` as the owner,
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
  // An idle-connection error would otherwise be an unhandled 'error' event; the query that follows reports it.
  admin.on('error', () => undefined);
  await admin.connect();
  let runtimeList: string;
  try {
    // DDL cannot take bind parameters: the names are validated above and quoted here.
    const quoted = admin.escapeIdentifier(database);
    runtimeList = runtimeRoles.map((r) => admin.escapeIdentifier(r)).join(', ');
    await dropWhenFree(admin, database);
    await admin.query(`CREATE DATABASE ${quoted} OWNER ${admin.escapeIdentifier(owner)}`);
    await admin.query(`REVOKE ALL ON DATABASE ${quoted} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${quoted} TO ${runtimeList}`);
  } finally {
    await admin.end();
  }

  const pools: Pool[] = [];
  const open = (role: string, max: number): Pool => {
    const pool = createPool(config, {
      role,
      database,
      max,
      connectionTimeoutMillis: TEST_CONNECT_TIMEOUT_MS,
    });
    pools.push(pool);
    return pool;
  };
  // One end() per pool however often close is called: a second pool.end() throws and would hide the failure that
  // led to the second call.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.all(pools.map((pool) => pool.end())).then(() => undefined);
    return closing;
  };

  // Every pool is opened inside the try, so a failure at any step (missing password file, bad schema) ends them all.
  try {
    const ownerPool = open(owner, 4);
    await ownerPool.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${runtimeList}`);
    if (options.schema !== undefined) await ownerPool.query(options.schema);
    const result = { database, owner: ownerPool, app: open(app, 10), close };
    return auditor === undefined ? result : { ...result, auditor: open(auditor, 4) };
  } catch (error) {
    await close();
    throw error;
  }
}
