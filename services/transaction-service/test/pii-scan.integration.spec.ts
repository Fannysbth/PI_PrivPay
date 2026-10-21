import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { transactionModules } from '../src/transaction.module';

// Seam: the transaction service over HTTP, then the three scan targets of spec pengujian 6 on what it left behind: the
// answers, the log lines and the whole dump. A service that only receives tokens must hold no canary even when a
// caller sends one by mistake. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'transaction-pii-scan';
const ISSUER = 'privpay-dev-idp';
const person = buildCanary(41);

let db: TestDb;
let app: ServiceApp;
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
      aud: ['transaction-service'],
    },
    { privateKey: pair.privateKey, kid: KID },
  );
};

beforeEach(async () => {
  db = await createTestDb(pg, { service: 'transaction', suffix: 'm401p' });
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
      service: 'transaction-service',
      modules: transactionModules({ fetch: fetchStub, pools: { app: db.app } }),
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
    .post('/transaction')
    .set('authorization', `Bearer ${gateway()}`)
    .send(body);
const valid = (over: Record<string, unknown> = {}) => ({
  transaction_id: 'TX-1000000000001',
  idempotency_key: ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-'),
  customer_token: 'PSEU-00000001',
  account_token: 'PSEU-00000002',
  merchant_id: 'MRC-001',
  amount: 35000,
  geohash: 'qqgu4',
  ...over,
});

describe('M4-01 NFR-15 FR-16 S-38 the three targets on the transaction service', () => {
  it('M4-01 NFR-15 FR-16 S-43 a caller that sends the identity by mistake is refused, and no canary is in an answer, the log or the dump', async () => {
    const answers = [
      await send(
        valid({
          nik: person.nik,
          nama: person.nama,
          email: person.email,
          source_account: person.rekening,
          customer_id: person.customer_id,
          hp: person.hp,
        }),
      ),
      // The canary where a token belongs, and as a merchant: refused by shape, never echoed.
      await send(valid({ customer_token: person.customer_id, idempotency_key: 'k-2' })),
      await send(valid({ account_token: person.rekening, idempotency_key: 'k-3' })),
      await send(valid({ merchant_id: person.nama, idempotency_key: 'k-4' })),
      await send(valid()),
      await send(valid({ transaction_id: 'TX-1000000000002' })),
      await send(valid({ transaction_id: 'TX-1000000000003', amount: 36000 })),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([422, 422, 422, 422, 201, 200, 409]);

    const where = { service: 'transaction' };
    assertNoFindings(
      scanText(JSON.stringify(answers.map((answer): unknown => answer.body)), [person], {
        ...where,
        location: 'response',
      }),
    );
    assertNoFindings(scanText(logLines.join('\n'), [person], { ...where, location: 'log' }));
    assertNoFindings(await scanDatabase(db.owner, [person], 'transaction'));
  });
});

describe('M4-01 the scan can fail', () => {
  it('M4-01 NFR-15 a canary written into the database is found, so a clean result means something', async () => {
    await db.owner.query(`UPDATE merchants SET name = $1 WHERE merchant_id = 'MRC-001'`, [
      person.nama,
    ]);
    const findings = await scanDatabase(db.owner, [person], 'transaction');
    expect(findings.length).toBeGreaterThan(0);
  });
});
