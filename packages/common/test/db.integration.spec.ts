import { loadConfig } from '../src/config';
import {
  createPool,
  pgConfigSchema,
  SERVICE_DBS,
  withTransaction,
  type ServiceName,
} from '../src/db';
import { createAdminPool, createTestDb, TEST_ADMIN_ROLE } from '../src/testing';

// Needs PostgreSQL and the roles from scripts/db/bootstrap.ps1; settings come from PG_HOST, PG_PORT, PG_SECRETS_DIR.
const config = loadConfig(pgConfigSchema, process.env);
const SERVICES = Object.keys(SERVICE_DBS) as ServiceName[];

describe('M0-05 the bootstrap created every role and database (ADR-0004, NFR-09)', () => {
  const admin = createAdminPool(config);
  afterAll(async () => {
    await admin.end();
  });

  it.each(SERVICES)(
    'M0-05 roles for %s exist without superuser, createrole or createdb',
    async (service) => {
      const { owner, app, auditor } = SERVICE_DBS[service];
      const roles = [owner, app, ...(auditor === undefined ? [] : [auditor])];
      const { rows } = await admin.query<{
        rolname: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolcanlogin: boolean;
      }>(
        'SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)',
        [roles],
      );
      expect(rows.map((r) => r.rolname).sort()).toEqual([...roles].sort());
      for (const role of rows) {
        expect(role).toMatchObject({
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolcanlogin: true,
        });
      }
    },
  );

  it.each(SERVICES)(
    'M0-05 the %s database exists and is owned by its schema owner',
    async (service) => {
      const { database, owner } = SERVICE_DBS[service];
      const { rows } = await admin.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [database],
      );
      expect(rows).toEqual([{ owner }]);
    },
  );

  it('M0-05 the test admin may create databases but is not a superuser', async () => {
    const { rows } = await admin.query<{ rolsuper: boolean; rolcreatedb: boolean }>(
      'SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = $1',
      [TEST_ADMIN_ROLE],
    );
    expect(rows).toEqual([{ rolsuper: false, rolcreatedb: true }]);
  });

  // ADR-0004: after the bootstrap only the test admin can SET ROLE to (or inherit) a schema owner. The admin who ran it
  // keeps at most the ADMIN option PostgreSQL 16+ gives a role's creator; that grants no privilege until it re-grants itself.
  it('M0-05 only the test admin can use the schema owner roles after the bootstrap', async () => {
    const owners = SERVICES.map((service) => SERVICE_DBS[service].owner);
    const { rows } = await admin.query<{ owner: string; member: string }>(
      `SELECT o.rolname AS owner, m.rolname AS member
         FROM pg_auth_members am
         JOIN pg_roles o ON o.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
        WHERE o.rolname = ANY($1) AND (am.set_option OR am.inherit_option)
        ORDER BY 1, 2`,
      [owners],
    );
    expect(rows).toEqual([...owners].sort().map((owner) => ({ owner, member: TEST_ADMIN_ROLE })));
  });
});

describe('M0-05 the harness hands out the real roles of a clean database', () => {
  it('M0-05 connects as the schema owner, the runtime role and (for privacy) the auditor role', async () => {
    const db = await createTestDb(config, { service: 'privacy', suffix: 'm005a' });
    try {
      const who = async (pool: typeof db.owner | undefined): Promise<string | undefined> =>
        (await pool?.query<{ current_user: string }>('SELECT current_user'))?.rows[0]?.current_user;
      expect(await who(db.owner)).toBe('privpay_privacy_owner');
      expect(await who(db.app)).toBe('privpay_app');
      expect(await who(db.auditor)).toBe('privpay_auditor');
    } finally {
      await db.close();
    }
  });

  it('M0-05 recreates the database from scratch on every run', async () => {
    const first = await createTestDb(config, { service: 'fraud', suffix: 'm005b' });
    try {
      await first.owner.query('CREATE TABLE leftover (id int)');
    } finally {
      await first.close();
    }
    const second = await createTestDb(config, { service: 'fraud', suffix: 'm005b' });
    try {
      const { rows } = await second.owner.query('SELECT 1 FROM pg_tables WHERE tablename = $1', [
        'leftover',
      ]);
      expect(rows).toHaveLength(0);
    } finally {
      await second.close();
    }
  });

  it('M0-05 applies the given schema as the owner, and the runtime role gets nothing it was not granted', async () => {
    const db = await createTestDb(config, {
      service: 'transaction',
      suffix: 'm005c',
      schema: 'CREATE TABLE t (id int); INSERT INTO t VALUES (1);',
    });
    try {
      expect((await db.owner.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }]);
      await expect(db.app.query('SELECT id FROM t')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.close();
    }
  });

  it.each(SERVICES)('M0-05 the runtime role of %s cannot alter the schema', async (service) => {
    const db = await createTestDb(config, { service, suffix: 'm005d' });
    try {
      await expect(db.app.query('CREATE TABLE x (id int)')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(db.owner.query('CREATE TABLE x (id int)')).resolves.toBeDefined();
    } finally {
      await db.close();
    }
  });

  it('M0-05 creating and closing a test database leaves the service database in place', async () => {
    const db = await createTestDb(config, { service: 'notification', suffix: 'm005e' });
    await db.close();
    const admin = createAdminPool(config);
    try {
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        SERVICE_DBS.notification.database,
      ]);
      expect(rows).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });
});

describe('M0-05 services cannot reach each other databases (invariant 4)', () => {
  it('M0-05 the privacy runtime role cannot connect to the transaction database', async () => {
    const pool = createPool(config, {
      role: SERVICE_DBS.privacy.app,
      database: SERVICE_DBS.transaction.database,
    });
    try {
      await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pool.end();
    }
  });

  it('M0-05 a runtime role cannot connect to another service database in either direction', async () => {
    const pairs: [ServiceName, ServiceName][] = [
      ['transaction', 'fraud'],
      ['fraud', 'notification'],
      ['notification', 'reconciliation'],
      ['reconciliation', 'privacy'],
    ];
    for (const [from, to] of pairs) {
      const pool = createPool(config, {
        role: SERVICE_DBS[from].app,
        database: SERVICE_DBS[to].database,
      });
      try {
        await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    }
  });
});

describe('M0-05 withTransaction commits on success and rolls back on failure', () => {
  it('M0-05 keeps the work of a successful transaction and discards a failed one', async () => {
    const db = await createTestDb(config, {
      service: 'reconciliation',
      suffix: 'm005f',
      schema: 'CREATE TABLE t (id int PRIMARY KEY);',
    });
    try {
      await withTransaction(db.owner, async (client) => {
        await client.query('INSERT INTO t VALUES (1)');
      });
      await expect(
        withTransaction(db.owner, async (client) => {
          await client.query('INSERT INTO t VALUES (2)');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await db.owner.query('SELECT id FROM t ORDER BY id')).rows).toEqual([{ id: 1 }]);
    } finally {
      await db.close();
    }
  });
});
