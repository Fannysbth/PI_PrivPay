import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { fraudModules } from '../src/fraud.module';

// Seam: POST /fraud/assess over HTTP, with the service's real module on the real database and the IdP's keys served by
// a stub (AZ-31, spec fraud 3). Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'fraud-http-test';
const ISSUER = 'privpay-dev-idp';

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;
let logLines: string[];

const jwt = (client: string, aud = ['fraud-service']): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub: client, azp: client, aud },
    { privateKey: pair.privateKey, kid: KID },
  );
};

const fraudEnv = (over: Record<string, string> = {}): Record<string, string> => ({
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
  ...over,
});

beforeEach(async () => {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  db = await createTestDb(pg, { service: 'fraud', suffix: 'm404h' });
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
    fraudEnv(),
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const body = (over: Record<string, unknown> = {}) => ({
  pseudonym: 'PSEU-7BCD04F2',
  amount: 2_000_000,
  tx_hour: 13,
  geohash: 'qqgu7',
  ...over,
});
const post = (token: string | undefined, payload: unknown) => {
  const call = request(app.httpServer)
    .post('/fraud/assess')
    .send(payload as object);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};
const transaction = () => jwt('transaction');
const count = async (): Promise<number> =>
  Number(
    (await db.owner.query<{ n: string }>('SELECT count(*) AS n FROM fraud_assessments')).rows[0]?.n,
  );

describe('M4-04 AZ-31 POST /fraud/assess', () => {
  it('M4-04 AZ-31 N1 no credential or an expired token is 401 and writes nothing', async () => {
    expect((await post(undefined, body())).status).toBe(401);
    const old = transaction();
    clock.advance(301);
    expect((await post(old, body())).status).toBe(401);
    expect(await count()).toBe(0);
  });

  it.each([['api-gateway'], ['reconciliation'], ['notification'], ['fraud']])(
    'M4-04 AZ-31 N2 the service %s is POLICY_NOT_ALLOWED and writes nothing',
    async (client) => {
      const answer = await post(jwt(client), body());
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(await count()).toBe(0);
    },
  );

  it('M4-04 AZ-31 N2 a token meant for another service is refused and writes nothing', async () => {
    expect((await post(jwt('transaction', ['privacy-service']), body())).status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('M4-04 AZ-31 N3 an unknown field is 422 and writes nothing', async () => {
    expect((await post(transaction(), body({ extra: 1 }))).status).toBe(422);
    expect(await count()).toBe(0);
  });

  it.each([
    ['customer_id'],
    ['nik'],
    ['nama'],
    ['requesting_service'],
    ['transaction_id'],
    ['subject_id'],
  ])(
    'M4-04 AZ-31 N4 the field %s in the body is 422: no identity, no transaction and no claim of who calls',
    async (field) => {
      expect((await post(transaction(), body({ [field]: 'x' }))).status).toBe(422);
      expect(await count()).toBe(0);
    },
  );

  it.each([
    ['tx_hour 24', { tx_hour: 24 }],
    ['tx_hour -1', { tx_hour: -1 }],
    ['tx_hour as text', { tx_hour: '13' }],
    ['tx_hour fractional', { tx_hour: 1.5 }],
    ['geohash with an invalid letter (a)', { geohash: 'aaaaa' }],
    ['geohash too long', { geohash: 'qqgu7qqgu7qqg' }],
    ['geohash in capitals', { geohash: 'QQGU7' }],
    ['amount 0', { amount: 0 }],
    ['amount fractional', { amount: 1.5 }],
    ['amount as text', { amount: '2000000' }],
    ['pseudonym not a token', { pseudonym: 'CUST-000101' }],
    ['pseudonym as an account number', { pseudonym: '1234567801' }],
    ['a missing field', { geohash: undefined }],
  ])('M4-04 S-40 %s is 422 and writes nothing', async (_name, over) => {
    const answer = await post(transaction(), body(over));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { reason: 'VALIDATION_ERROR' } });
    expect(await count()).toBe(0);
  });

  it('M4-04 FR-37 TF-12 the first call is a cold start; the second uses the first and answers 75 and HOLD_FOR_VERIFICATION', async () => {
    const first = await post(transaction(), body());
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      risk_score: 10,
      decision: 'ALLOW',
      rules_fired: ['AMOUNT_OVER_THRESHOLD'],
      rules_skipped: expect.arrayContaining([
        'AMOUNT_OVER_3X_AVG',
        'NEW_LOCATION_VS_LAST_3',
      ]) as unknown,
      prior_count: 0,
    });
    clock.advance(3600);
    const second = await post(
      transaction(),
      body({ amount: 8_000_000, tx_hour: 2, geohash: 'qqt8h' }),
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      risk_score: 75,
      decision: 'HOLD_FOR_VERIFICATION',
      rules_skipped: [],
      prior_count: 1,
    });
    expect(await count()).toBe(2);
  });

  it('M4-04 NFR-15 the log of the calls carries no token, no amount and no place', async () => {
    await post(transaction(), body());
    await post(transaction(), body({ amount: 8_123_456, geohash: 'qqt8h' }));
    const log = logLines.join(' ');
    for (const value of ['PSEU-7BCD04F2', '2000000', '8123456', 'qqgu7', 'qqt8h']) {
      expect(log).not.toContain(value);
    }
  });
});

describe('M4-04 K-20 the start needs its settings', () => {
  it.each([
    ['FRAUD_AMOUNT_THRESHOLD'],
    ['FRAUD_ODD_HOUR_START'],
    ['FRAUD_ODD_HOUR_END'],
    ['FRAUD_HOLD_THRESHOLD'],
    ['FRAUD_BLOCK_THRESHOLD'],
  ])(
    'M4-04 K-20 without %s the service does not start and names only the variable',
    async (name) => {
      const without: Record<string, string | undefined> = { ...fraudEnv(), [name]: undefined };
      const error = await createServiceApp(
        { service: 'fraud-service', modules: fraudModules({ pools: { app: db.app } }) },
        without,
      ).catch((caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(name);
    },
  );

  it('M4-04 K-20 a hold threshold that is not under the block threshold stops the start', async () => {
    await expect(
      createServiceApp(
        { service: 'fraud-service', modules: fraudModules({ pools: { app: db.app } }) },
        fraudEnv({ FRAUD_HOLD_THRESHOLD: '90', FRAUD_BLOCK_THRESHOLD: '90' }),
      ),
    ).rejects.toThrow();
  });

  it.each([
    ['swapped (start 6, end 22)', { FRAUD_ODD_HOUR_START: '6', FRAUD_ODD_HOUR_END: '22' }],
    ['empty (start 22, end 22)', { FRAUD_ODD_HOUR_START: '22', FRAUD_ODD_HOUR_END: '22' }],
  ])(
    'M4-04 K-20 a night window that is %s would fire for every hour and stops the start',
    async (_name, env) => {
      await expect(
        createServiceApp(
          { service: 'fraud-service', modules: fraudModules({ pools: { app: db.app } }) },
          fraudEnv(env),
        ),
      ).rejects.toThrow('FRAUD_ODD_HOUR');
    },
  );

  it('M4-04 K-20 an hour outside 0..23 stops the start', async () => {
    await expect(
      createServiceApp(
        { service: 'fraud-service', modules: fraudModules({ pools: { app: db.app } }) },
        fraudEnv({ FRAUD_ODD_HOUR_START: '24' }),
      ),
    ).rejects.toThrow();
  });
});
