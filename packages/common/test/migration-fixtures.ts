import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MigrationError, type MigrationFailure } from '../src/migrate';

/** Writes `<root>/<folder>/<file>`; the migration tests build their fixture trees with it. */
export function putMigration(root: string, folder: string, file: string, sql: string): void {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, file), sql);
}

/** The `reason` of the MigrationError thrown by `fn`; any other error is rethrown. */
export function failureReason(fn: () => unknown): MigrationFailure | 'no error' {
  try {
    fn();
  } catch (error) {
    if (error instanceof MigrationError) return error.reason;
    throw error;
  }
  return 'no error';
}

/** Same for a promise. */
export async function failureReasonOf(
  work: Promise<unknown>,
): Promise<MigrationFailure | 'no error'> {
  try {
    await work;
  } catch (error) {
    if (error instanceof MigrationError) return error.reason;
    throw error;
  }
  return 'no error';
}
