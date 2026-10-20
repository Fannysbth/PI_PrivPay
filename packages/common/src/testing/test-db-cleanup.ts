import { Client, type Pool } from 'pg';
import { readRolePassword, SERVICE_DBS, type PgConfig } from '../db';
import { dropWhenFree, TEST_ADMIN_ROLE } from './test-db';

export type DatabaseKind = 'service' | 'test' | 'other';

export interface PrivpayDatabase {
  readonly name: string;
  readonly kind: DatabaseKind;
  readonly owner: string;
  readonly bytes: number;
  /** Sessions open on it now, from any role (pgAdmin included). */
  readonly sessions: number;
}

export interface DropResult {
  readonly dropped: string[];
  /** `code` is the SQLSTATE; 42501 means a session of a role the test admin may not end (a superuser, pgAdmin). */
  readonly failed: { name: string; code: string }[];
}

const SERVICE_DATABASES: ReadonlySet<string> = new Set(
  Object.values(SERVICE_DBS).map((service) => service.database),
);

// Exactly the names `testDatabaseName` can produce: a service database name, `_test_`, a short [a-z0-9] suffix. Not
// the loose LIKE 'privpay_%_test_%' (an underscore is a wildcard in LIKE, so it would also match other databases).
const TEST_DATABASE = new RegExp(
  `^(?:${Object.values(SERVICE_DBS)
    .map((service) => service.database)
    .join('|')})_test_[a-z0-9]{1,20}$`,
);

/** The only decision about what may be dropped: only `test` ever is. Service and unknown names never are. */
export function classifyDatabase(name: string): DatabaseKind {
  if (SERVICE_DATABASES.has(name)) return 'service';
  return TEST_DATABASE.test(name) ? 'test' : 'other';
}

/** Read-only: every database whose name starts with `privpay_`, with owner, size and open sessions. */
export async function listPrivpayDatabases(admin: Pool): Promise<PrivpayDatabase[]> {
  const { rows } = await admin.query<{
    name: string;
    owner: string;
    bytes: string;
    sessions: string;
  }>(
    `SELECT d.datname AS name,
            pg_get_userbyid(d.datdba) AS owner,
            pg_database_size(d.datname) AS bytes,
            (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS sessions
       FROM pg_database d
      WHERE starts_with(d.datname, 'privpay_')
      ORDER BY d.datname`,
  );
  return rows.map((row) => ({
    name: row.name,
    kind: classifyDatabase(row.name),
    owner: row.owner,
    bytes: Number(row.bytes),
    sessions: Number(row.sessions),
  }));
}

/**
 * Drops test databases. Every name is checked before the first connection, so one bad name drops none of them
 * (all or nothing at the guard). A database that cannot be dropped is reported in `failed` and the rest continues.
 */
export async function dropTestDatabases(
  config: PgConfig,
  names: readonly string[],
): Promise<DropResult> {
  for (const name of names) {
    if (classifyDatabase(name) !== 'test') {
      throw new RangeError('only test databases of a service can be dropped');
    }
  }
  const result: DropResult = { dropped: [], failed: [] };
  if (names.length === 0) return result;

  const admin = new Client({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: TEST_ADMIN_ROLE,
    password: readRolePassword(config.PG_SECRETS_DIR, TEST_ADMIN_ROLE),
    database: 'postgres',
  });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    for (const name of names) {
      try {
        await dropWhenFree(admin, name);
        result.dropped.push(name);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        result.failed.push({ name, code: typeof code === 'string' ? code : 'unknown' });
      }
    }
  } finally {
    await admin.end();
  }
  return result;
}

export interface TestDatabaseStore {
  list(): Promise<PrivpayDatabase[]>;
  drop(names: readonly string[]): Promise<DropResult>;
}

export interface CliDeps {
  readonly store: TestDatabaseStore;
  /** Reads one line typed by the person at the keyboard. */
  readonly ask: (prompt: string) => Promise<string>;
  readonly out: (line: string) => void;
}

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function show(out: CliDeps['out'], title: string, rows: readonly PrivpayDatabase[]): void {
  out(`${title} (${String(rows.length)})`);
  for (const row of rows) {
    const held = row.sessions > 0 ? `  [${String(row.sessions)} open session(s)]` : '';
    out(`  ${row.name}  ${row.owner}  ${megabytes(row.bytes)}${held}`);
  }
}

/**
 * `list` (default) shows the service databases and the test leftovers and touches nothing. `drop` shows the test
 * databases it would drop, then needs the exact answer `DROP <count>` typed at the prompt: there is no flag that
 * skips it. Returns the exit code: 0 done, 1 not done or partly failed, 2 usage.
 */
export async function runTestDatabasesCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [command = 'list', ...rest] = args;
  if ((command !== 'list' && command !== 'drop') || rest.length > 0) {
    deps.out('usage: test-databases [list | drop]   (drop always asks for a typed confirmation)');
    return 2;
  }
  const all = await deps.store.list();
  const services = all.filter((database) => database.kind === 'service');
  const tests = all.filter((database) => database.kind === 'test');
  show(deps.out, 'Service databases (never touched by this tool)', services);
  show(deps.out, 'Test databases (leftovers of integration tests)', tests);
  if (command === 'list') return 0;

  if (tests.length === 0) {
    deps.out('Nothing to drop.');
    return 0;
  }
  const expected = `DROP ${String(tests.length)}`;
  const answer = await deps.ask(
    `Type "${expected}" to drop the ${String(tests.length)} test databases above: `,
  );
  const names = tests.map((database) => database.name);
  if (answer !== expected || names.some((name) => classifyDatabase(name) !== 'test')) {
    deps.out('Nothing was dropped.');
    return 1;
  }
  const result = await deps.store.drop(names);
  deps.out(`Dropped ${String(result.dropped.length)} of ${String(names.length)}.`);
  for (const failure of result.failed) {
    deps.out(`  could not drop ${failure.name}: ${failure.code}`);
  }
  return result.failed.length === 0 ? 0 : 1;
}
