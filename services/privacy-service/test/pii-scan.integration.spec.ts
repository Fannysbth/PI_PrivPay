import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { privacyModules } from '../src/privacy.module';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';

// Seam: the privacy service over HTTP, then the three scan targets of spec pengujian 6 on what it left behind: the
// database dump, audit_log, and the log lines. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'pii-scan-test';
const ISSUER = 'privpay-dev-idp';
const person = buildCanary(31);

let db: TestDb;
let app: ServiceApp;
let dir: string;
let logLines: string[];
const clock = new FakeClock('2026-10-20T08:00:00.000Z');

const gateway = (): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    {
      iss: ISSUER,
      iat,
      exp: iat + 300,
      jti: 'fake-jti',
      sub: 'api-gateway',
      azp: 'api-gateway',
      aud: ['privacy-service'],
    },
    { privateKey: pair.privateKey, kid: KID },
  );
};

beforeEach(async () => {
  db = await createTestDb(pg, { service: 'privacy', suffix: 'm210' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  dir = mkdtempSync(join(tmpdir(), 'privpay-pii-scan-'));
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${Buffer.alloc(32, byte).toString('hex')}\n`);
  }
  logLines = [];
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const fetchStub: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  app = await createServiceApp(
    {
      service: 'privacy-service',
      modules: privacyModules({
        fetch: fetchStub,
        pools: { app: db.app, ...(db.auditor === undefined ? {} : { auditor: db.auditor }) },
      }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      PG_HOST: pg.PG_HOST,
      PG_PORT: String(pg.PG_PORT),
      PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: ISSUER,
      GRACE_PERIOD_SECONDS: '30',
      TTL_PAYMENT_PROCESSING: '900',
      TTL_FRAUD_DETECTION: '2592000',
      TTL_NOTIFICATION: '900',
      TTL_NOTIFICATION_REGISTRATION: '31536000',
      TTL_DAILY_RECONCILIATION: '86400',
      TTL_INTERNAL_AUDIT: '600',
      PSEUDONYM_KEY_VERSION: '1',
      PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
      BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
      FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
    },
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  await db.close();
});

/** Registration (A5) and the first payment's tokens (B1): the flows that carry every canary into the service. */
async function runScenario(): Promise<void> {
  const send = (path: string, body: object) =>
    request(app.httpServer).post(path).set('authorization', `Bearer ${gateway()}`).send(body);
  const stored = await send('/identity', {
    customer_id: person.customer_id,
    nik: person.nik,
    nama: person.nama,
    hp: person.hp,
    rekening: person.rekening,
  });
  expect(stored.status).toBe(201);
  const rest = {
    target_service: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transaction_id: 'TX-9001',
  };
  const p1 = await send('/pseudonymize', {
    subject_type: 'CUSTOMER',
    subject_id: person.customer_id,
    ...rest,
  });
  const p2 = await send('/pseudonymize', {
    subject_type: 'ACCOUNT',
    subject_id: person.rekening,
    ...rest,
  });
  expect([p1.status, p2.status]).toEqual([200, 200]);
}

describe('M2-10 the three targets on the privacy service', () => {
  it('M2-10 NFR-15 FR-15 S-43 zero findings in audit_log, the log and the whole dump (ciphertext only)', async () => {
    await runScenario();
    const audit = await db.owner.query<Record<string, unknown>>('SELECT * FROM audit_log');
    expect(audit.rows.length).toBeGreaterThan(0);
    const where = { service: 'privacy' };
    assertNoFindings(
      scanText(JSON.stringify(audit.rows), [person], { ...where, location: 'audit_log' }),
    );
    assertNoFindings(scanText(logLines.join('\n'), [person], { ...where, location: 'log' }));
    assertNoFindings(await scanDatabase(db.owner, [person], 'privacy'));
  });

  it('M2-10 positive: a canary planted in the log makes the scan fail', async () => {
    await runScenario();
    logLines.push(`user ${person.nama} registered`);
    const findings = scanText(logLines.join('\n'), [person], {
      service: 'privacy',
      location: 'log',
    });
    expect(() => {
      assertNoFindings(findings);
    }).toThrow(/nama in log of privacy/);
  });

  it('M2-10 positive: a canary planted in a plain column of the dump is found there', async () => {
    await runScenario();
    await db.owner.query(
      'INSERT INTO transaction_status (transaction_id, status) VALUES ($1, $2)',
      [person.customer_id, 'PENDING'],
    );
    expect(await scanDatabase(db.owner, [person], 'privacy')).toEqual([
      {
        attribute: 'customer_id',
        location: 'transaction_status.transaction_id',
        service: 'privacy',
      },
    ]);
  });
});
