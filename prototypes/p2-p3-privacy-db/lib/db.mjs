// THROWAWAY test harness. Host/port from env (ADR-0004); passwords read from files under secrets/ (never printed).
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool, Client } = pg;
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} must be set: host and port come from the environment (ADR-0004)`);
  return value;
};
const host = required('PG_HOST');
const port = Number(required('PG_PORT'));
if (!Number.isInteger(port)) throw new Error('PG_PORT must be an integer');
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
    // DDL cannot take bind parameters; the identifier is validated above and quoted here.
    const ident = admin.escapeIdentifier(name);
    await admin.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ident} OWNER privpay_privacy_owner`);
    await admin.query(`REVOKE ALL ON DATABASE ${ident} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident} TO privpay_app, privpay_auditor`);
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
