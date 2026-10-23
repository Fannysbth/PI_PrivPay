import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import {
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  signJwt,
  type PrivacyMode,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { fraudModules } from '../src/fraud.module';

// Seam: POST /fraud/assess in each mode, with the service's real module over the database of that mode (M5-02,
// ADR-0006, FR-23). The module picks the repository and the form of the reference from PRIVACY_MODE. Every value is
// invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'fraud-mode-test';
const ISSUER = 'privpay-dev-idp';
const TOKEN = ['PSEU', '7BCD04F2'].join('-');
const CUSTOMER_ID = ['CUST', '000101'].join('-');

const fraudEnv = (mode: PrivacyMode): Record<string, string> => ({
  PRIVACY_MODE: mode,
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
});

interface Running {
  readonly db: TestDb;
  readonly app: ServiceApp;
  readonly clock: FakeClock;
  assess(reference: string): Promise<request.Response>;
  rows(): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

async function start(mode: PrivacyMode): Promise<Running> {
  const clock = new FakeClock('2026-10-23T08:00:00.000Z');
  const db = await createTestDb(pg, { service: 'fraud', suffix: `m502${mode.slice(0, 1)}` });
  await migrate(db.owner, { root: migrations, mode });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const fetchStub: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const app = await createServiceApp(
    {
      service: 'fraud-service',
      modules: fraudModules({ fetch: fetchStub, pools: { app: db.app } }),
    },
    fraudEnv(mode),
    { clock },
  );
  const jwt = (): string => {
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
  return {
    db,
    app,
    clock,
    assess: (reference) =>
      request(app.httpServer)
        .post('/fraud/assess')
        .set('authorization', `Bearer ${jwt()}`)
        .send({ pseudonym: reference, amount: 2_000_000, tx_hour: 13, geohash: 'qqgu7' }),
    rows: async () =>
      (await db.owner.query<Record<string, unknown>>('SELECT * FROM fraud_assessments')).rows,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

describe('M5-02 FR-23 Fraud in proposed mode', () => {
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('M5-02 FR-23 a token is assessed and stored under pseudonym', async () => {
    running = await start('proposed');
    const answer = await running.assess(TOKEN);
    expect(answer.status).toBe(200);
    expect(await running.rows()).toMatchObject([{ pseudonym: TOKEN }]);
  });

  it('M5-02 FR-23 a customer id is refused at the edge and writes nothing', async () => {
    running = await start('proposed');
    expect((await running.assess(CUSTOMER_ID)).status).toBe(422);
    expect(await running.rows()).toEqual([]);
  });
});

describe('M5-02 FR-23 Fraud in baseline mode', () => {
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('M5-02 FR-23 a customer id is assessed and stored under customer_id: the baseline repository is the one in use', async () => {
    running = await start('baseline');
    const answer = await running.assess(CUSTOMER_ID);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ prior_count: 0 });
    expect(await running.rows()).toMatchObject([{ customer_id: CUSTOMER_ID }]);
  });

  it('M5-02 FR-23 the same customer has a history: the second assessment counts the first, as in proposed', async () => {
    running = await start('baseline');
    await running.assess(CUSTOMER_ID);
    const second = await running.assess(CUSTOMER_ID);
    expect(second.body).toMatchObject({ prior_count: 1 });
  });

  it('M5-02 FR-23 a token is refused at the edge and writes nothing', async () => {
    running = await start('baseline');
    expect((await running.assess(TOKEN)).status).toBe(422);
    expect(await running.rows()).toEqual([]);
  });
});
