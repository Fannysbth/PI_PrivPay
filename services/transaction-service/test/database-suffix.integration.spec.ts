import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { transactionModules } from '../src/transaction.module';

// Seam: the real Transaction module with no pool handed in, so it opens its own pool by the name in the environment
// (N-50, PG_DATABASE_SUFFIX). The row must land in the database of that suffix and in no other. Every value is invented.
// Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'transaction-suffix-test';
const ISSUER = 'privpay-dev-idp';
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');

let dir: string;
let db: TestDb | undefined;
let app: ServiceApp | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-transaction-suffix-'));
  writeFileSync(
    join(dir, 'transaction_client_secret'),
    'fake-secret-transaction-0123456789abcdef\n',
  );
});
afterEach(async () => {
  await app?.close();
  await db?.close();
  app = undefined;
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('N-50 the service connects to the database of its suffix', () => {
  it('N-50 a payment is stored in privpay_transaction_test_<suffix>, as the real runtime role', async () => {
    const clock = new FakeClock('2026-10-23T08:00:00.000Z');
    db = await createTestDb(pg, { service: 'transaction', suffix: 'n50tx' });
    await migrate(db.owner, { root: migrations, mode: 'baseline' });
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const network: typeof fetch = (input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.hostname === 'notification.test') return Promise.resolve(json({ status: 'SENT' }));
      if (url.pathname === '/token')
        return Promise.resolve(json({ access_token: 'fake-service-token', expires_in: 300 }));
      return Promise.resolve(json({ keys: [jwk] }));
    };
    app = await createServiceApp(
      { service: 'transaction-service', modules: transactionModules({ fetch: network }) },
      {
        PRIVACY_MODE: 'baseline',
        PORT: '0',
        PG_HOST: pg.PG_HOST,
        PG_PORT: String(pg.PG_PORT),
        PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
        PG_DATABASE_SUFFIX: 'n50tx',
        IDP_URL: 'http://idp.test',
        IDP_ISSUER: ISSUER,
        FRAUD_AMOUNT_THRESHOLD: '1000000',
        TX_PENDING_TIMEOUT_SECONDS: '300',
        TX_SWEEP_INTERVAL_SECONDS: '30',
        FRAUD_SERVICE_URL: 'http://fraud.test',
        NOTIFICATION_SERVICE_URL: 'http://notification.test',
        TRANSACTION_CLIENT_SECRET_FILE: join(dir, 'transaction_client_secret'),
      },
      { clock },
    );
    const iat = Math.floor(clock.now().getTime() / 1000);
    const token = signJwt(
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
    const answer = await request(app.httpServer)
      .post('/transaction')
      .set('authorization', `Bearer ${token}`)
      .send({
        transaction_id: 'TX-1000000000050',
        idempotency_key: KEY,
        customer_token: ['CUST', '000101'].join('-'),
        account_token: '1234567801',
        merchant_id: 'MRC-001',
        amount: 35_000,
        geohash: 'qqgu4',
      });
    expect(answer.status).toBe(201);
    const rows = await db.owner.query('SELECT transaction_id FROM transactions');
    expect(rows.rows).toEqual([{ transaction_id: 'TX-1000000000050' }]);
  });
});
