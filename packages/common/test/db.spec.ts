import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/config';
import { createPool, pgConfigSchema, readRolePassword, SERVICE_DBS } from '../src/db';
import { testDatabaseName } from '../src/testing';

const CANARY = 'canary-db-password-5b1f9c3a7d2e4f60';

describe('M0-05 every service has its own database and roles (ADR-0004, invariant 4)', () => {
  it('M0-05 lists the five services', () => {
    expect(Object.keys(SERVICE_DBS).sort()).toEqual([
      'fraud',
      'notification',
      'privacy',
      'reconciliation',
      'transaction',
    ]);
  });

  it('M0-05 names every database and role with the privpay_ prefix and no two services share one', () => {
    const names = Object.values(SERVICE_DBS).flatMap((s) => [
      s.database,
      s.owner,
      s.app,
      ...(s.auditor === undefined ? [] : [s.auditor]),
    ]);
    for (const name of names) expect(name).toMatch(/^privpay_[a-z0-9_]+$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it('M0-05 keeps the PRD roles for privacy and one owner/app pair for each other service', () => {
    expect(SERVICE_DBS.privacy).toEqual({
      database: 'privpay_privacy',
      owner: 'privpay_privacy_owner',
      app: 'privpay_app',
      auditor: 'privpay_auditor',
    });
    expect(SERVICE_DBS.transaction).toEqual({
      database: 'privpay_transaction',
      owner: 'privpay_transaction_owner',
      app: 'privpay_transaction_app',
    });
    for (const service of ['fraud', 'notification', 'reconciliation'] as const) {
      expect(SERVICE_DBS[service].auditor).toBeUndefined();
    }
  });
});

describe('M0-05 database settings come from the environment (ADR-0004)', () => {
  it('M0-05 requires PG_HOST and PG_PORT and defaults only the secrets directory', () => {
    expect(() => loadConfig(pgConfigSchema, {})).toThrow(ConfigError);
    expect(loadConfig(pgConfigSchema, { PG_HOST: 'localhost', PG_PORT: '5432' })).toEqual({
      PG_HOST: 'localhost',
      PG_PORT: 5432,
      PG_SECRETS_DIR: './secrets',
    });
  });

  it.each(['0', '70000', 'abc'])('M0-05 rejects PG_PORT %s', (port) => {
    expect(() => loadConfig(pgConfigSchema, { PG_HOST: 'localhost', PG_PORT: port })).toThrow(
      ConfigError,
    );
  });
});

describe('M0-05 role passwords are read from files and never echoed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privpay-db-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('M0-05 reads <role>_password from the secrets directory', () => {
    writeFileSync(join(dir, 'privpay_app_password'), `${CANARY}\n`);
    expect(readRolePassword(dir, 'privpay_app')).toBe(CANARY);
  });

  it('M0-05 fails without printing the secret when the file is missing or empty', () => {
    writeFileSync(join(dir, 'privpay_fraud_app_password'), '\n');
    for (const role of ['privpay_missing_app', 'privpay_fraud_app']) {
      expect(() => readRolePassword(dir, role)).toThrow(ConfigError);
    }
  });

  it.each([
    'postgres',
    'privpay',
    'privpay_',
    'Privpay_app',
    'privpay_app; drop',
    '../privpay_app',
  ])('M0-05 refuses the role name %j', (role) => {
    expect(() => readRolePassword(dir, role)).toThrow(RangeError);
  });
});

describe('M0-05 pools only reach privpay_ roles and databases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privpay-pool-'));
  writeFileSync(join(dir, 'privpay_app_password'), CANARY);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const config = { PG_HOST: 'db.internal', PG_PORT: 5433, PG_SECRETS_DIR: dir };

  it('M0-05 builds a lazy pool from the settings and the role password file', async () => {
    const pool = createPool(config, { role: 'privpay_app', database: 'privpay_privacy' });
    try {
      expect(pool.options).toMatchObject({
        host: 'db.internal',
        port: 5433,
        user: 'privpay_app',
        database: 'privpay_privacy',
      });
    } finally {
      await pool.end();
    }
  });

  it.each([
    { role: 'postgres', database: 'privpay_privacy' },
    { role: 'privpay_app', database: 'bems' },
    { role: 'privpay_app', database: 'privpay_privacy; drop database x' },
  ])('M0-05 refuses %j', (options) => {
    expect(() => createPool(config, options)).toThrow(RangeError);
  });
});

describe('M0-05 test databases have predictable, namespaced names', () => {
  it('M0-05 names the database privpay_<service>_test_<suffix>', () => {
    expect(testDatabaseName('privacy', 'm005a')).toBe('privpay_privacy_test_m005a');
  });

  it.each(['', 'UPPER', 'with space', 'a'.repeat(21), 'x;drop', '../x'])(
    'M0-05 refuses the suffix %j',
    (suffix) => {
      expect(() => testDatabaseName('fraud', suffix)).toThrow(RangeError);
    },
  );
});
