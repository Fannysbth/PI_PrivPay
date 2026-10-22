import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { loadConfig } from '../src/config';
import { pgConfigSchema } from '../src/db';
import { MIGRATION_LOCK_KEY, MigrationError, migrate } from '../src/migrate';
import { createTestDb, type TestDb } from '../src/testing';
import { failureReasonOf as reasonOf, putMigration } from './migration-fixtures';

// Needs PostgreSQL and the roles from scripts/db/bootstrap.ps1 (same settings as db.integration.spec.ts).
const config = loadConfig(pgConfigSchema, process.env);

type Queryable = Pool | PoolClient;

let root: string;
let db: TestDb;
let suffixCounter = 0;

const put = (folder: string, file: string, sql: string): void => {
  putMigration(root, folder, file, sql);
};
const tables = async (pool: Queryable): Promise<string[]> => {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
  );
  return rows.map((r) => r.tablename);
};
const recorded = async (pool: Queryable): Promise<string[]> => {
  const { rows } = await pool.query<{ version: number; name: string }>(
    'SELECT version, name FROM schema_migrations ORDER BY version',
  );
  return rows.map((r) => `${String(r.version)}:${r.name}`);
};

// One database per test so the tests do not depend on each other (suffix is a short counter).
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'privpay-mig-it-'));
  suffixCounter += 1;
  db = await createTestDb(config, {
    service: 'transaction',
    suffix: `m004${String(suffixCounter)}`,
  });
});
afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('M0-04 migrate applies the files in order and records them', () => {
  it('M0-04 creates schema_migrations with the version, name, SHA-256 and time of each file', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('common', '0002_create_b.sql', 'CREATE TABLE b (id int);\n');
    put('proposed', '0003_create_c.sql', 'CREATE TABLE c (id int);\n');
    const result = await migrate(db.owner, { root, mode: 'proposed' });
    expect(result.applied).toEqual(['0001_create_a', '0002_create_b', '0003_create_c']);
    expect(await tables(db.owner)).toEqual(['a', 'b', 'c', 'schema_migrations']);
    // The time is the database's own now(), so it is compared in SQL instead of against the test machine's clock.
    const { rows } = await db.owner.query<{ checksum: string; recent: boolean }>(
      "SELECT checksum, applied_at BETWEEN now() - interval '1 minute' AND now() AS recent FROM schema_migrations ORDER BY version",
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.recent).toBe(true);
    }
  });

  it('M0-04 running it twice changes nothing the second time', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    await migrate(db.owner, { root, mode: 'proposed' });
    const before = await db.owner.query('SELECT * FROM schema_migrations ORDER BY version');
    const second = await migrate(db.owner, { root, mode: 'proposed' });
    expect(second.applied).toEqual([]);
    const after = await db.owner.query('SELECT * FROM schema_migrations ORDER BY version');
    expect(after.rows).toEqual(before.rows);
  });

  it('M0-04 applies only the files that are new on a later run', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    await migrate(db.owner, { root, mode: 'proposed' });
    put('common', '0002_create_b.sql', 'CREATE TABLE b (id int);\n');
    expect((await migrate(db.owner, { root, mode: 'proposed' })).applied).toEqual([
      '0002_create_b',
    ]);
  });

  it('M0-04 the folder of the mode decides which files run (ADR-0006)', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('proposed', '0002_only_proposed.sql', 'CREATE TABLE only_proposed (id int);\n');
    put('baseline', '0002_only_baseline.sql', 'CREATE TABLE only_baseline (id int);\n');
    await migrate(db.owner, { root, mode: 'baseline' });
    expect(await tables(db.owner)).toEqual(['a', 'only_baseline', 'schema_migrations']);
  });

  it('M0-04 refuses to switch an existing database to the other mode', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('proposed', '0002_only_proposed.sql', 'CREATE TABLE only_proposed (id int);\n');
    put('baseline', '0002_only_baseline.sql', 'CREATE TABLE only_baseline (id int);\n');
    await migrate(db.owner, { root, mode: 'proposed' });
    expect(await reasonOf(migrate(db.owner, { root, mode: 'baseline' }))).toBe('applied_mismatch');
    expect(await tables(db.owner)).not.toContain('only_baseline');
  });
});

describe('M0-04 migrate refuses a history that no longer matches the files', () => {
  it('M0-04 an applied file whose content changed fails, and a pending file after it is not run', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    await migrate(db.owner, { root, mode: 'proposed' });
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int, extra int);\n');
    put('common', '0002_create_b.sql', 'CREATE TABLE b (id int);\n');
    expect(await reasonOf(migrate(db.owner, { root, mode: 'proposed' }))).toBe('checksum_changed');
    expect(await tables(db.owner)).toEqual(['a', 'schema_migrations']);
  });

  it('M0-04 an applied file that was deleted fails', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('common', '0002_create_b.sql', 'CREATE TABLE b (id int);\n');
    await migrate(db.owner, { root, mode: 'proposed' });
    rmSync(join(root, 'common', '0002_create_b.sql'));
    expect(await reasonOf(migrate(db.owner, { root, mode: 'proposed' }))).toBe('applied_missing');
  });

  it('M0-04 a file renamed or renumbered after it was applied fails', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    await migrate(db.owner, { root, mode: 'proposed' });
    rmSync(join(root, 'common', '0001_create_a.sql'));
    put('common', '0001_create_other.sql', 'CREATE TABLE a (id int);\n');
    expect(await reasonOf(migrate(db.owner, { root, mode: 'proposed' }))).toBe('applied_mismatch');
  });

  it('M0-04 a gap or a duplicate in the numbering fails before anything is applied', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('common', '0003_create_c.sql', 'CREATE TABLE c (id int);\n');
    expect(await reasonOf(migrate(db.owner, { root, mode: 'proposed' }))).toBe('numbering');
    expect(await tables(db.owner)).toEqual([]);
  });
});

describe('M0-04 each migration is one transaction', () => {
  it('M0-04 a failing migration leaves none of its statements and no row, and later files do not run', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put(
      'common',
      '0002_half_done.sql',
      'CREATE TABLE half_done (id int);\nINSERT INTO half_done VALUES (1 / 0);\n',
    );
    put('common', '0003_create_c.sql', 'CREATE TABLE c (id int);\n');
    const failure = await migrate(db.owner, { root, mode: 'proposed' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as MigrationError).reason).toBe('failed');
    // The message names the file, never the SQL.
    expect((failure as MigrationError).message).toContain('0002_half_done');
    expect((failure as MigrationError).message).not.toContain('INSERT');
    expect(await tables(db.owner)).toEqual(['a', 'schema_migrations']);
    expect(await recorded(db.owner)).toEqual(['1:create_a']);
  });

  it('M0-04 after the failing file is fixed the next run continues from it', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('common', '0002_broken.sql', 'THIS IS NOT SQL;\n');
    await reasonOf(migrate(db.owner, { root, mode: 'proposed' }));
    put('common', '0002_broken.sql', 'CREATE TABLE b (id int);\n');
    expect((await migrate(db.owner, { root, mode: 'proposed' })).applied).toEqual(['0002_broken']);
  });

  it('M0-04 a runner waits while another one holds the migration lock, then applies every file once', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('common', '0002_create_b.sql', 'CREATE TABLE b (id int);\n');
    const holder = await db.owner.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
      const waiting = migrate(db.owner, { root, mode: 'proposed' });
      const state = { finished: false };
      void waiting.then(
        () => (state.finished = true),
        () => (state.finished = true),
      );
      // Poll the lock table of this database instead of sleeping: the runner is blocked once its request shows up
      // ungranted. The bound is a deadline rather than a poll count (opening a connection takes longer on a loaded
      // machine than a count allows) and turns a runner that failed early, or never blocks, into a failure instead of a hang.
      let blocked = false;
      const until = Date.now() + 20_000;
      for (let attempt = 0; Date.now() < until && !blocked && !state.finished; attempt += 1) {
        const { rows } = await holder.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
        blocked = rows[0]?.n === '1';
      }
      expect(blocked).toBe(true);
      expect(await tables(holder)).toEqual([]);
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
      expect((await waiting).applied).toEqual(['0001_create_a', '0002_create_b']);
    } finally {
      holder.release();
    }
    expect(await recorded(db.owner)).toEqual(['1:create_a', '2:create_b']);
  });

  it('M0-04 two runners started together end with every file recorded once', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    put('common', '0002_create_b.sql', 'CREATE TABLE b (id int);\n');
    const results = await Promise.all([
      migrate(db.owner, { root, mode: 'proposed' }),
      migrate(db.owner, { root, mode: 'proposed' }),
    ]);
    expect(results.flatMap((r) => r.applied).sort()).toEqual(['0001_create_a', '0002_create_b']);
    expect(await recorded(db.owner)).toEqual(['1:create_a', '2:create_b']);
  });
});

describe('M0-04 only the schema owner may run the migrations', () => {
  it('M0-04 the runtime role fails before it changes anything', async () => {
    put('common', '0001_create_a.sql', 'CREATE TABLE a (id int);\n');
    expect(await reasonOf(migrate(db.app, { root, mode: 'proposed' }))).toBe('not_owner');
    expect(await tables(db.owner)).toEqual([]);
  });

  it('M0-04 after a failed run the pool still works and no advisory lock is kept', async () => {
    put('common', '0001_create_a.sql', 'THIS IS NOT SQL;\n');
    await reasonOf(migrate(db.owner, { root, mode: 'proposed' }));
    // Only this database: the lock space is per database, and other databases may be in use.
    const { rows } = await db.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks
        WHERE locktype = 'advisory'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});
