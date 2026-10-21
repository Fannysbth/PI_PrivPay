import type { Canary } from './canary';
import { scanText, type Finding } from './scan';

/** The part of a `pg` pool this needs, so the harness has no dependency of its own (tests/ is not a package). */
export interface ScannedPool {
  connect(): Promise<{
    query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
    escapeIdentifier(name: string): string;
    release(): void;
  }>;
}

function textOf(cell: unknown): string {
  if (Buffer.isBuffer(cell)) return cell.toString('latin1');
  if (cell instanceof Date) return cell.toISOString();
  if (typeof cell === 'object') return JSON.stringify(cell);
  return typeof cell === 'string' ? cell : JSON.stringify(cell);
}

/**
 * Target 2 of docs/spec/pengujian-dan-pengukuran.md 6: every column of every table of the public schema, read as the
 * owner role (test only). A bytea column is read byte for byte, so a canary stored in the clear is found and one
 * that is ciphertext is not. The location is `table.column`; no value leaves this function.
 */
export async function scanDatabase(
  pool: ScannedPool,
  canaries: readonly Canary[],
  service: string,
): Promise<Finding[]> {
  const client = await pool.connect();
  try {
    const tables = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const seen = new Map<string, Finding>();
    for (const { tablename: name } of tables.rows) {
      const tablename = String(name);
      // An identifier cannot be a bind parameter; it comes from the catalogue and is quoted by the driver.
      const result = await client.query(`SELECT * FROM ${client.escapeIdentifier(tablename)}`);
      for (const row of result.rows) {
        for (const [column, cell] of Object.entries(row)) {
          if (cell === null || cell === undefined) continue;
          const location = `${tablename}.${column}`;
          for (const finding of scanText(textOf(cell), canaries, { service, location })) {
            seen.set(`${finding.attribute}|${finding.location}`, finding);
          }
        }
      }
    }
    return [...seen.values()];
  } finally {
    client.release();
  }
}
