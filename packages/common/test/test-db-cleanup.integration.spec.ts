import { Client } from 'pg';
import { loadConfig } from '../src/config';
import { pgConfigSchema, readRolePassword, SERVICE_DBS } from '../src/db';
import {
  createAdminPool,
  createTestDb,
  dropTestDatabases,
  listPrivpayDatabases,
  type TestDb,
} from '../src/testing';

// Needs PostgreSQL and the roles from scripts/db/bootstrap.ps1. Only databases created here (suffixes m006a..m006g of
// the privacy service) are ever dropped, and they are dropped again at the end so this file leaves no leftovers; the
// service databases are only listed.
const config = loadConfig(pgConfigSchema, process.env);
const admin = createAdminPool(config);
const open: TestDb[] = [];
const createdNames = new Set<string>();
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});
afterAll(async () => {
  await admin.end();
  await dropTestDatabases(config, [...createdNames]);
});

const names = async (): Promise<string[]> =>
  (await listPrivpayDatabases(admin)).map((database) => database.name);

async function created(suffix: string): Promise<TestDb> {
  const db = await createTestDb(config, { service: 'privacy', suffix });
  open.push(db);
  createdNames.add(db.database);
  return db;
}

describe('M0-05 listing the privpay databases of the server', () => {
  it('M0-05 shows a test database as test and the five service databases as service', async () => {
    const db = await created('m006a');
    const all = await listPrivpayDatabases(admin);
    expect(all.find((d) => d.name === db.database)).toMatchObject({
      kind: 'test',
      owner: SERVICE_DBS.privacy.owner,
    });
    const services = all.filter((d) => d.kind === 'service').map((d) => d.name);
    expect(services.sort()).toEqual(
      Object.values(SERVICE_DBS)
        .map((s) => s.database)
        .sort(),
    );
    for (const database of all) expect(database.name.startsWith('privpay_')).toBe(true);
  });

  it('M0-05 counts the sessions open on a database', async () => {
    const db = await created('m006a');
    await db.app.query('SELECT 1');
    const row = (await listPrivpayDatabases(admin)).find((d) => d.name === db.database);
    expect(row?.sessions).toBeGreaterThanOrEqual(1);
  });
});

describe('M0-05 dropping test databases', () => {
  it('M0-05 drops the named test databases and leaves the others and the service databases', async () => {
    const a = await created('m006b');
    const b = await created('m006c');
    await a.close();
    await b.close();
    open.length = 0;
    const result = await dropTestDatabases(config, [a.database]);
    expect(result).toEqual({ dropped: [a.database], failed: [] });
    const after = await names();
    expect(after).not.toContain(a.database);
    expect(after).toContain(b.database);
    for (const service of Object.values(SERVICE_DBS)) expect(after).toContain(service.database);
  });

  it('M0-05 refuses a list with any name that is not a test database, and drops none of it', async () => {
    const a = await created('m006b');
    await a.close();
    open.length = 0;
    // No real service database name here on purpose: if the guard ever regressed, this test must not be what drops
    // one. That a service name is refused is proved without a database in test-db-cleanup.spec.ts (classifyDatabase).
    for (const bad of [
      'postgres',
      'privpay_unknown_test_m006b',
      'privpay_privacy_test_m006b; DROP DATABASE privpay_nothing',
    ]) {
      await expect(dropTestDatabases(config, [a.database, bad])).rejects.toBeInstanceOf(RangeError);
    }
    const after = await names();
    expect(after).toContain(a.database);
    expect(after).toContain(SERVICE_DBS.privacy.database);
  });

  // A session the cleaner may not end (privpay_test_admin is no member of privpay_app) must keep the drop at 42501 however
  // long it takes. The holder is a dedicated pg Client, not a pooled connection: pg-pool closes an idle pooled connection
  // after 10 s (idleTimeoutMillis, pg-pool 3.14), which ended the session when the machine was slow and made this test red
  // (N-52). The production createPool is not changed. `waitMs` is real time on purpose: the property is independence of
  // elapsed time, so the slow case waits longer than the idle timeout of a pool.
  async function heldSessionCase(
    suffixHeld: string,
    suffixFree: string,
    waitMs: number,
  ): Promise<void> {
    const held = await created(suffixHeld);
    const holder = new Client({
      host: config.PG_HOST,
      port: config.PG_PORT,
      user: SERVICE_DBS.privacy.app,
      password: readRolePassword(config.PG_SECRETS_DIR, SERVICE_DBS.privacy.app),
      database: held.database,
    });
    holder.on('error', () => undefined);
    await holder.connect();
    try {
      await holder.query('SELECT 1');
      const free = await created(suffixFree);
      await free.close();
      open.splice(open.indexOf(free), 1);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const first = await dropTestDatabases(config, [held.database, free.database]);
      expect(first.dropped).toEqual([free.database]);
      expect(first.failed).toEqual([{ name: held.database, code: '42501' }]);
    } finally {
      await holder.end();
    }
    await held.close();
    open.length = 0;
    expect(await dropTestDatabases(config, [held.database])).toEqual({
      dropped: [held.database],
      failed: [],
    });
  }

  it('M0-05 a database held by a session it may not end is reported, the rest is still dropped, and it goes once the session ends', async () => {
    await heldSessionCase('m006d', 'm006e', 0);
  });

  it('M0-05 N-52 the same holds when the drop comes more than 10 s later than the session was opened (slow machine)', async () => {
    await heldSessionCase('m006f', 'm006g', 11_000);
  }, 60_000);
});
