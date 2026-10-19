// THROWAWAY test harness. Host/port from env (ADR-0004); passwords read from files under secrets/ (never printed).
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool, Client } = pg;
const host = process.env.PG_HOST ?? 'localhost';
const port = Number(process.env.PG_PORT ?? 5432);
const secretsDir = process.env.PG_SECRETS_DIR ?? fileURLToPath(new URL('../../../secrets/', import.meta.url));

const password = (role) => readFileSync(join(secretsDir, `${role}_password`), 'utf8').trim();
const conn = (user, database) => ({ host, port, user, password: password(user), database });

export const newKeys = () => ({ kToken: randomBytes(32), kIndex: randomBytes(32), kField: randomBytes(32) });

export class Clock {
  constructor() { this.ms = Date.UTC(2026, 9, 5, 12, 0, 0); }
  now() { return this.ms; }
  advance(seconds) { this.ms += seconds * 1000; }
}

// Recreates a clean test database (only names starting with privpay_), applies schema as the schema owner,
// and returns pools that connect as the real runtime roles.
export async function createTestDb(name, schemaSql) {
  if (!/^privpay_[a-z0-9_]+$/.test(name)) throw new Error('refusing to touch a database not named privpay_*');
  const admin = new Client(conn('privpay_test_admin', 'postgres'));
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name} OWNER privpay_privacy_owner`);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO privpay_app, privpay_auditor`);
  } finally { await admin.end(); }

  const owner = new Client(conn('privpay_privacy_owner', name));
  await owner.connect();
  try { await owner.query(schemaSql); } finally { await owner.end(); }

  const pools = {
    owner: new Pool({ ...conn('privpay_privacy_owner', name), max: 4 }),
    app: new Pool({ ...conn('privpay_app', name), max: Number(process.env.P2_POOL ?? 25) }),
    auditor: new Pool({ ...conn('privpay_auditor', name), max: 4 }),
  };
  return { ...pools, close: () => Promise.all(Object.values(pools).map((p) => p.end())) };
}
