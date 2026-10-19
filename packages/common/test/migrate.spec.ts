import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrations } from '../src/migrate';
import { failureReason as reason, putMigration } from './migration-fixtures';

// Fixture trees only; the SQL is never run here (migrate.integration.spec.ts runs it against PostgreSQL).
describe('M0-04 readMigrations lists the common folder, then the folder of the mode (ADR-0006)', () => {
  let root: string;
  const put = (folder: string, file: string, sql = 'SELECT 1;\n'): void => {
    putMigration(root, folder, file, sql);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'privpay-mig-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('M0-04 returns common first and then the mode folder, numbered without gaps', () => {
    put('common', '0001_create_a.sql');
    put('common', '0002_create_b.sql');
    put('proposed', '0003_proposed_only.sql');
    put('baseline', '0003_baseline_only.sql');
    expect(readMigrations(root, 'proposed').map((m) => [m.version, m.name])).toEqual([
      [1, 'create_a'],
      [2, 'create_b'],
      [3, 'proposed_only'],
    ]);
    expect(readMigrations(root, 'baseline').map((m) => m.name)).toEqual([
      'create_a',
      'create_b',
      'baseline_only',
    ]);
  });

  it('M0-04 treats a missing mode folder as empty but a missing root as an error', () => {
    put('common', '0001_create_a.sql');
    expect(readMigrations(root, 'baseline')).toHaveLength(1);
    expect(reason(() => readMigrations(join(root, 'nope'), 'proposed'))).toBe('root_missing');
  });

  it('M0-04 rejects a gap in the numbering', () => {
    put('common', '0001_a.sql');
    put('common', '0003_c.sql');
    expect(reason(() => readMigrations(root, 'proposed'))).toBe('numbering');
  });

  it('M0-04 rejects a duplicate number, also across common and the mode folder', () => {
    put('common', '0001_a.sql');
    put('proposed', '0001_b.sql');
    expect(reason(() => readMigrations(root, 'proposed'))).toBe('numbering');
  });

  it('M0-04 rejects a numbering that does not start at 1', () => {
    put('common', '0002_a.sql');
    expect(reason(() => readMigrations(root, 'proposed'))).toBe('numbering');
  });

  it.each([
    '1_short.sql',
    '0001_Upper.sql',
    '0001_a-b.sql',
    '0001_a.SQL',
    '0001.sql',
    'notes.txt',
    '0001_a.sql.bak',
  ])('M0-04 rejects the file name %s', (file) => {
    put('common', file);
    expect(reason(() => readMigrations(root, 'proposed'))).toBe('file_name');
  });

  it('M0-04 ignores a .gitkeep but nothing else that is not a migration', () => {
    put('common', '.gitkeep', '');
    put('common', '0001_a.sql');
    expect(readMigrations(root, 'proposed')).toHaveLength(1);
  });

  it('M0-04 rejects a directory inside a migration folder', () => {
    put('common', '0001_a.sql');
    mkdirSync(join(root, 'common', '0002_dir.sql'));
    expect(reason(() => readMigrations(root, 'proposed'))).toBe('file_name');
  });

  it('M0-04 rejects an empty migration file', () => {
    put('common', '0001_a.sql', '  \n');
    expect(reason(() => readMigrations(root, 'proposed'))).toBe('empty');
  });

  it('M0-04 rejects a mode other than baseline or proposed', () => {
    put('common', '0001_a.sql');
    expect(reason(() => readMigrations(root, 'static' as 'proposed'))).toBe('mode');
  });

  it('M0-04 checksum is the SHA-256 of the file and does not depend on the line endings', () => {
    put('common', '0001_a.sql', 'CREATE TABLE a (id int);\nSELECT 1;\n');
    put('proposed', '0002_b.sql', 'CREATE TABLE b (id int);\r\nSELECT 1;\r\n');
    const [first, second] = readMigrations(root, 'proposed');
    expect(first?.checksum).toBe(
      createHash('sha256').update('CREATE TABLE a (id int);\nSELECT 1;\n').digest('hex'),
    );
    // A checkout with autocrlf must not look like an edited migration.
    expect(second?.checksum).toBe(
      createHash('sha256').update('CREATE TABLE b (id int);\nSELECT 1;\n').digest('hex'),
    );
  });

  it('M0-04 the error names the file but never prints its SQL', () => {
    const secretLooking = 'SELECT 1; -- FAKE-CANARY-do-not-print';
    put('common', '0001_a.sql', secretLooking);
    put('common', '0003_c.sql', secretLooking);
    let message = '';
    try {
      readMigrations(root, 'proposed');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('0003_c.sql');
    expect(message).not.toContain('FAKE-CANARY');
  });

  it('M0-04 reports a migration folder that cannot be read as a MigrationError, not a raw fs error', () => {
    put('common', '0001_a.sql');
    // A file where the mode folder should be: readdir fails with ENOTDIR.
    writeFileSync(join(root, 'proposed'), 'not a folder');
    expect(reason(() => readMigrations(root, 'proposed'))).toBe('unreadable');
  });

  it('M0-04 does not follow a link that leads out of the migrations tree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'privpay-mig-out-'));
    try {
      mkdirSync(join(outside, 'common'));
      writeFileSync(join(outside, 'common', '0001_a.sql'), 'SELECT 1;\n');
      // A junction needs no privilege on Windows; on POSIX the type argument is ignored and it is a plain symlink.
      symlinkSync(join(outside, 'common'), join(root, 'common'), 'junction');
      expect(reason(() => readMigrations(root, 'proposed'))).toBe('file_name');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
