import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { fraudModules } from '../src/fraud.module';

// Seam: the fraud service over HTTP, then the three scan targets of spec pengujian 6 on what it left behind: the
// answers, the log lines and the whole dump. A service that only receives a token and numbers must hold no canary even
// when a caller sends one by mistake. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'fraud-pii-scan';
const ISSUER = 'privpay-dev-idp';
const person = buildCanary(42);

let db: TestDb;
let app: ServiceApp;
let logLines: string[];
const clock = new FakeClock('2026-10-20T08:00:00.000Z');

const transaction = (): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    {
      iss: ISSUER,
      iat,
      exp: iat + 300,
      jti: 'fake-jti',
      sub: 'transaction',
      azp: 'transaction',
      aud: ['fraud-service'],
    },
    { privateKey: pair.privateKey, kid: KID },
  );
};

beforeEach(async () => {
  db = await createTestDb(pg, { service: 'fraud', suffix: 'm404p' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
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
      service: 'fraud-service',
      modules: fraudModules({ fetch: fetchStub, pools: { app: db.app } }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      PG_HOST: pg.PG_HOST,
      PG_PORT: String(pg.PG_PORT),
      PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: ISSUER,
      FRAUD_AMOUNT_THRESHOLD: '1000000',
      FRAUD_ODD_HOUR_START: '22',
      FRAUD_ODD_HOUR_END: '6',
      FRAUD_HOLD_THRESHOLD: '50',
      FRAUD_BLOCK_THRESHOLD: '90',

      FRAUD_HISTORY_DAYS: '30',
    },
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const send = (body: object) =>
  request(app.httpServer)
    .post('/fraud/assess')
    .set('authorization', `Bearer ${transaction()}`)
    .send(body);
const valid = (over: Record<string, unknown> = {}) => ({
  pseudonym: 'PSEU-7BCD04F2',
  amount: 2_000_000,
  tx_hour: 13,
  geohash: 'qqgu7',
  ...over,
});

describe('M4-04 NFR-15 FR-18 S-38 the three targets on the fraud service', () => {
  it('M4-04 NFR-15 FR-18 S-43 a caller that sends the identity by mistake is refused, and no canary is in an answer, the log or the dump', async () => {
    const answers = [
      await send(
        valid({
          nik: person.nik,
          nama: person.nama,
          email: person.email,
          rekening: person.rekening,
          customer_id: person.customer_id,
          hp: person.hp,
        }),
      ),
      // The canary where a token or a place belongs: refused by shape, never echoed.
      await send(valid({ pseudonym: person.customer_id })),
      await send(valid({ pseudonym: person.rekening })),
      await send(valid({ geohash: person.nama })),
      await send(valid()),
      await send(valid({ amount: 8_000_000, tx_hour: 2, geohash: 'qqt8h' })),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([422, 422, 422, 422, 200, 200]);

    const where = { service: 'fraud' };
    assertNoFindings(
      scanText(JSON.stringify(answers.map((answer): unknown => answer.body)), [person], {
        ...where,
        location: 'response',
      }),
    );
    assertNoFindings(scanText(logLines.join('\n'), [person], { ...where, location: 'log' }));
    assertNoFindings(await scanDatabase(db.owner, [person], 'fraud'));
  });

  it('M4-04 NFR-15 the scan can fail: a canary written into the database is found', async () => {
    await db.owner.query(`UPDATE risk_rules SET parameter = $1 WHERE rule = 'AMOUNT_OVER_3X_AVG'`, [
      person.nik,
    ]);
    expect((await scanDatabase(db.owner, [person], 'fraud')).length).toBeGreaterThan(0);
  });
});
