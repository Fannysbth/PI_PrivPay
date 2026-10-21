import { generateKeyPairSync } from 'node:crypto';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { join } from 'node:path';
import request from 'supertest';
import { transactionModules } from '../src/transaction.module';
import { neighbours } from './fakes';

// Seam: POST /transaction over HTTP, with the service's real module on the real database and the IdP's keys served
// by a stub (AZ-26, spec transaction 3.1). Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'transaction-http-test';
const ISSUER = 'privpay-dev-idp';
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;
let logLines: string[];

const jwt = (client: string, aud = ['transaction-service'], extra: object = {}): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub: client, azp: client, aud, ...extra },
    { privateKey: pair.privateKey, kid: KID },
  );
};

beforeEach(async () => {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  db = await createTestDb(pg, { service: 'transaction', suffix: 'm401h' });
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
      modules: transactionModules({
        fetch: fetchStub,
        pools: { app: db.app },
        neighbours: neighbours({ fraudDown: true }),
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
      FRAUD_AMOUNT_THRESHOLD: '1000000',
      TX_PENDING_TIMEOUT_SECONDS: '300',
      PRIVACY_SERVICE_URL: 'http://privacy.test',
      FRAUD_SERVICE_URL: 'http://fraud.test',
      NOTIFICATION_SERVICE_URL: 'http://notification.test',
    },
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const body = (over: Record<string, unknown> = {}) => ({
  transaction_id: 'TX-1000000000001',
  idempotency_key: KEY,
  customer_token: 'PSEU-00000001',
  account_token: 'PSEU-00000002',
  merchant_id: 'MRC-001',
  amount: 35000,
  geohash: 'qqgu4',
  ...over,
});
const post = (token: string | undefined, payload: unknown) => {
  const call = request(app.httpServer)
    .post('/transaction')
    .send(payload as object);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};
const gateway = () => jwt('api-gateway');
const count = async (): Promise<number> =>
  Number(
    (await db.owner.query<{ n: string }>('SELECT count(*) AS n FROM transactions')).rows[0]?.n,
  );

describe('M4-01 AZ-26 POST /transaction', () => {
  it('M4-01 AZ-26 N1 no credential or an expired token is 401 and write nothing', async () => {
    expect((await post(undefined, body())).status).toBe(401);
    const old = jwt('api-gateway');
    clock.advance(301);
    expect((await post(old, body())).status).toBe(401);
    expect(await count()).toBe(0);
  });

  it.each([['fraud'], ['reconciliation'], ['notification'], ['transaction']])(
    'M4-01 AZ-26 N2 the service %s is POLICY_NOT_ALLOWED and writes nothing',
    async (client) => {
      const answer = await post(jwt(client), body());
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(await count()).toBe(0);
    },
  );

  it('M4-01 AZ-26 N2 a token for another service is refused and writes nothing', async () => {
    expect((await post(jwt('api-gateway', ['privacy-service']), body())).status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('M4-01 AZ-26 N3 an unknown field is 422 and writes nothing', async () => {
    const answer = await post(gateway(), body({ extra: 1 }));
    expect(answer.status).toBe(422);
    expect(await count()).toBe(0);
  });

  it.each([
    ['requesting_service'],
    ['status'],
    ['customer_id'],
    ['nik'],
    ['nama'],
    ['email'],
    ['source_account'],
  ])(
    'M4-01 AZ-26 N4 the field %s in the body is 422: no identity and no claim of who calls',
    async (field) => {
      const answer = await post(gateway(), body({ [field]: 'x' }));
      expect(answer.status).toBe(422);
      expect(await count()).toBe(0);
    },
  );

  it.each([
    ['amount 0', { amount: 0 }],
    ['amount negative', { amount: -1 }],
    ['amount fractional', { amount: 1.5 }],
    ['amount as text', { amount: '35000' }],
    ['amount above the safe range', { amount: Number.MAX_SAFE_INTEGER + 2 }],
    ['unknown merchant', { merchant_id: 'MRC-999' }],
    ['merchant of the wrong shape', { merchant_id: 'merchant one' }],
    ['idempotency_key not a UUID', { idempotency_key: 'k-1' }],
    ['customer_token not a token', { customer_token: 'CUST-000101' }],
    ['account_token as an account number', { account_token: '1234567801' }],
    ['transaction_id of the wrong shape', { transaction_id: 'trx 1' }],
    ['geohash of the wrong shape', { geohash: 'QQGU4!' }],
    ['a missing field', { geohash: undefined }],
  ])('M4-01 K-16 %s is 422 and writes nothing', async (_name, over) => {
    const answer = await post(gateway(), body(over));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { reason: 'VALIDATION_ERROR' } });
    expect(await count()).toBe(0);
  });

  it('M4-01 FR-36 the first call is 201, the same call again is 200 with the first transaction_id, a different one is 409', async () => {
    const first = await post(gateway(), body());
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ transaction_id: 'TX-1000000000001', status: 'COMPLETED' });

    const again = await post(gateway(), body({ transaction_id: 'TX-1000000000002' }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    const other = await post(
      gateway(),
      body({ transaction_id: 'TX-1000000000003', amount: 36000 }),
    );
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    // The conflict does not give back what the first call stored.
    const text = JSON.stringify(other.body);
    for (const stored of ['TX-1000000000001', '35000', 'PSEU-00000001', 'qqgu4', 'COMPLETED']) {
      expect(text).not.toContain(stored);
    }
    expect(await count()).toBe(1);
  });

  it('M4-01 NFR-24 an amount at the threshold is HELD, never COMPLETED, until Fraud is wired', async () => {
    const answer = await post(gateway(), body({ amount: 1_000_000 }));
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ status: 'HELD' });
  });

  it('M4-01 NFR-15 the log of the calls carries no amount, no token and no key', async () => {
    await post(gateway(), body());
    await post(gateway(), body({ amount: 36000 }));
    const log = logLines.join(' ');
    for (const value of [KEY, 'PSEU-00000001', 'PSEU-00000002', '35000', '36000', 'qqgu4']) {
      expect(log).not.toContain(value);
    }
  });
});
