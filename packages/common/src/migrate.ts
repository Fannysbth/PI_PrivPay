import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

/** ADR-0003: only two conditions exist. */
export const PRIVACY_MODES = ['baseline', 'proposed'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export type MigrationFailure =
  | 'root_missing'
  | 'mode'
  | 'file_name'
  | 'unreadable'
  | 'numbering'
  | 'empty'
  | 'checksum_changed'
  | 'applied_missing'
  | 'applied_mismatch'
  | 'not_owner'
  | 'failed';

/**
 * Messages carry file names and versions only, never SQL text: a migration may contain seed values. `cause` can hold
 * the raw database error, whose detail may quote a row, so it is for the developer's debugger and must not be logged.
 */
export class MigrationError extends Error {
  constructor(
    readonly reason: MigrationFailure,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`migration ${reason}: ${detail}`, options);
    this.name = 'MigrationError';
  }
}

/** The connection could not roll back: it must be discarded, not returned to the pool. */
class UnusableConnection extends MigrationError {
  constructor(detail: string, cause: unknown) {
    super('failed', detail, { cause });
  }
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** `common` or the mode folder it came from. */
  readonly folder: string;
  readonly sql: string;
  readonly checksum: string;
}

// NNNN_name.sql (platform spec 10). The name is a lowercase identifier so it is safe in logs and in schema_migrations.
const FILE_NAME = /^(\d{4})_([a-z][a-z0-9_]{0,59})\.sql$/;
const IGNORED = new Set(['.gitkeep']);

function listFolder(root: string, folder: string): string[] {
  const path = join(root, folder);
  try {
    // lstat: a link could lead outside the tree the repository controls.
    if (lstatSync(path).isSymbolicLink()) {
      throw new MigrationError('file_name', `${folder} is a link`);
    }
    return readdirSync(path).sort();
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new MigrationError('unreadable', `${folder} cannot be read`, { cause: error });
  }
}

/** Line endings are normalised so a checkout with autocrlf does not look like an edited migration. */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * The migrations of one service for one mode: the `common` folder, then the folder of the mode (ADR-0006), as one
 * sequence numbered 1..n without gaps or duplicates. Files already applied are verified against it by `migrate`.
 */
export function readMigrations(root: string, mode: PrivacyMode): Migration[] {
  if (!PRIVACY_MODES.includes(mode)) throw new MigrationError('mode', 'unknown mode');
  try {
    if (!statSync(root).isDirectory()) throw new MigrationError('root_missing', 'not a directory');
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('root_missing', 'migrations directory not found', { cause: error });
  }

  const found: Migration[] = [];
  for (const folder of ['common', mode]) {
    for (const file of listFolder(root, folder)) {
      if (IGNORED.has(file)) continue;
      const match = FILE_NAME.exec(file);
      const path = join(root, folder, file);
      if (match === null || !lstatSync(path).isFile()) {
        throw new MigrationError('file_name', `${folder}/${file} is not NNNN_name.sql`);
      }
      const sql = readFileSync(path, 'utf8');
      if (sql.trim() === '') throw new MigrationError('empty', `${folder}/${file} is empty`);
      found.push({
        version: Number(match[1]),
        name: match[2] ?? '',
        folder,
        sql,
        checksum: checksumOf(sql),
      });
    }
  }

  found.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        'numbering',
        `${migration.folder}/${String(migration.version).padStart(4, '0')}_${migration.name}.sql is out of sequence, expected ${String(index + 1)}`,
      );
    }
  });
  return found;
}

// Advisory locks live in the database they are taken in, so one constant is enough ("PrivP" in ASCII).
export const MIGRATION_LOCK_KEY = '348242012496';

const label = (migration: Pick<Migration, 'version' | 'name'>): string =>
  `${String(migration.version).padStart(4, '0')}_${migration.name}`;

async function assertSchemaOwner(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ is_owner: boolean }>(
    'SELECT pg_get_userbyid(datdba) = current_user AS is_owner FROM pg_database WHERE datname = current_database()',
  );
  // Migrations run as the owner only; the runtime role must never get a way to change the schema (NFR-09).
  if (rows[0]?.is_owner !== true) {
    throw new MigrationError('not_owner', 'the connected role does not own the database');
  }
}

async function verifyHistory(
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<number> {
  const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  rows.forEach((row, index) => {
    const file = migrations[index];
    if (file === undefined) {
      throw new MigrationError('applied_missing', `applied migration ${label(row)} has no file`);
    }
    if (row.version !== file.version || row.name !== file.name) {
      throw new MigrationError(
        'applied_mismatch',
        `applied ${label(row)} does not match file ${label(file)}`,
      );
    }
    if (row.checksum !== file.checksum) {
      throw new MigrationError(
        'checksum_changed',
        `${label(file)} was edited after it was applied`,
      );
    }
  });
  return rows.length;
}

async function applyOne(client: PoolClient, migration: Migration): Promise<void> {
  await client.query('BEGIN');
  try {
    // No parameters: the simple protocol runs a file with several statements.
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A connection that cannot roll back is unusable; the caller destroys it.
      throw new UnusableConnection(
        `${label(migration)} failed and could not be rolled back`,
        new AggregateError([error, rollbackError]),
      );
    }
    // The cause keeps the database error for debugging; the message stays free of SQL text.
    throw new MigrationError('failed', `${label(migration)} could not be applied`, {
      cause: error,
    });
  }
}

/**
 * Applies the pending files of `readMigrations` in order, one transaction each, forward only (platform spec 10).
 * `pool` must connect as the schema owner; any other role fails before it changes anything. Safe to run twice and to
 * run from two processes at once (an advisory lock serialises them). Returns the labels of the files it applied.
 */
export async function migrate(
  pool: Pool,
  options: { root: string; mode: PrivacyMode },
): Promise<{ applied: string[] }> {
  const migrations = readMigrations(options.root, options.mode);
  const client = await pool.connect();
  let broken = false;
  try {
    await assertSchemaOwner(client);
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version integer PRIMARY KEY CHECK (version > 0),
         name text NOT NULL,
         checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await verifyHistory(client, migrations);
    const applied: string[] = [];
    for (const migration of migrations.slice(done)) {
      await applyOne(client, migration);
      applied.push(label(migration));
    }
    return { applied };
  } catch (error) {
    broken = error instanceof UnusableConnection;
    throw error;
  } finally {
    if (!broken) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
      } catch {
        // The session lock dies with the connection, so discarding it below is enough.
        broken = true;
      }
    }
    client.release(broken);
  }
}
