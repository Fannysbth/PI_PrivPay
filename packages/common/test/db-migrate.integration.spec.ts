import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { pgConfigSchema } from '../src/db';
import { migrateServices } from '../src/db-migrate';
import { createTestDb, type TestDb } from '../src/testing';

// Seam: migrateServices on a throwaway privacy database (never a service database): it creates the tables, a second
// run changes nothing, and a service with no migrations yet is skipped. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const repoRoot = join(__dirname, '..', '..', '..');

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'dbmig' });
});
afterEach(async () => {
  await db.close();
});

const tables = async (): Promise<string[]> =>
  (
    await db.owner.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
  ).rows.map((row) => row.table_name);

describe('M3 db:migrate creates and updates the tables of a service database', () => {
  it('M3 db:migrate applies the files once, then reports up to date, and skips a service without migrations', async () => {
    expect(await tables()).toEqual([]);
    const lines: string[] = [];
    const run = () =>
      migrateServices({
        repoRoot,
        mode: 'proposed',
        services: ['privacy', 'fraud'],
        openOwner: () => db.owner,
        out: (line) => lines.push(line),
      });

    await run();
    expect(lines[0]).toMatch(
      /^privacy: applied 0001_privacy_tables, 0002_privacy_grants, 0003_transaction_link/,
    );
    expect(lines[1]).toBe('fraud: no migrations yet, skipped');
    expect(await tables()).toEqual(
      expect.arrayContaining([
        'audit_log',
        'disclosure_request',
        'identity_vault',
        'pseudonym_mapping',
        'transaction_link',
        'transaction_status',
      ]),
    );

    lines.length = 0;
    await run();
    expect(lines[0]).toBe('privacy: up to date');
  });
});
