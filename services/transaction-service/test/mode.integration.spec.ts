import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { buildCanary } from '../../../tests/pii-scan/canary';
import { transactionModules } from '../src/transaction.module';

// Seam: POST /transaction and the detail Reconciliation reads, in each mode, with the service's real module over the
// database of that mode and the real HTTP adapters towards a stubbed network (M5-02, ADR-0006, N-44). Baseline stores
// the identity, hands it to Fraud and Notification as it is and never reaches Privacy; proposed refuses an identifier at
// the edge. Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'transaction-mode-test';
const ISSUER = 'privpay-dev-idp';
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');
const CUSTOMER_ID = ['CUST', '000101'].join('-');
const ACCOUNT_NUMBER = '1234567801';
const TOKEN = ['PSEU', '00000001'].join('-');

let dir: string;
let running: Running | undefined;

interface Running {
  readonly db: TestDb;
  readonly app: ServiceApp;
  readonly reached: string[];
  readonly fraudBodies: Record<string, unknown>[];
  readonly notificationBodies: Record<string, unknown>[];
  pay(over?: Record<string, unknown>): Promise<request.Response>;
  detail(id: string): Promise<request.Response>;
  rows(): Promise<Record<string, unknown>[]>;
}

const envFor = (mode: PrivacyMode, over: Record<string, string | undefined> = {}) => ({
  PRIVACY_MODE: mode,
  PORT: '0',
  PG_HOST: pg.PG_HOST,
  PG_PORT: String(pg.PG_PORT),
  PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: ISSUER,
  FRAUD_AMOUNT_THRESHOLD: '1000000',
  TX_PENDING_TIMEOUT_SECONDS: '300',
  TX_SWEEP_INTERVAL_SECONDS: '30',
  ...(mode === 'proposed' ? { PRIVACY_SERVICE_URL: 'http://privacy.test' } : {}),
  FRAUD_SERVICE_URL: 'http://fraud.test',
  NOTIFICATION_SERVICE_URL: 'http://notification.test',
  TRANSACTION_CLIENT_SECRET_FILE: join(dir, 'transaction_client_secret'),
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-transaction-mode-'));
  writeFileSync(
    join(dir, 'transaction_client_secret'),
    'fake-secret-transaction-0123456789abcdef\n',
  );
});
afterEach(async () => {
  await running?.app.close();
  await running?.db.close();
  running = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(mode: PrivacyMode): Promise<Running> {
  const clock = new FakeClock('2026-10-23T08:00:00.000Z');
  const db = await createTestDb(pg, { service: 'transaction', suffix: `m502${mode.slice(0, 1)}` });
  await migrate(db.owner, { root: migrations, mode });
  const reached: string[] = [];
  const fraudBodies: Record<string, unknown>[] = [];
  const notificationBodies: Record<string, unknown>[] = [];
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const network: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    reached.push(url.hostname);
    const sent =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.hostname === 'fraud.test') {
      fraudBodies.push(sent);
      return Promise.resolve(json({ risk_score: 10, decision: 'ALLOW' }));
    }
    if (url.hostname === 'notification.test') {
      notificationBodies.push(sent);
      return Promise.resolve(json({ status: 'SENT' }));
    }
    if (url.hostname === 'idp.test' && url.pathname === '/token') {
      return Promise.resolve(json({ access_token: 'fake-service-token', expires_in: 300 }));
    }
    if (url.hostname === 'idp.test') return Promise.resolve(json({ keys: [jwk] }));
    return Promise.resolve(json({}, 503));
  };
  const app = await createServiceApp(
    {
      service: 'transaction-service',
      modules: transactionModules({ fetch: network, pools: { app: db.app } }),
    },
    envFor(mode),
    { clock },
  );
  const jwt = (client: string): string => {
    const iat = Math.floor(clock.now().getTime() / 1000);
    return signJwt(
      {
        iss: ISSUER,
        iat,
        exp: iat + 300,
        jti: 'fake-jti',
        sub: client,
        azp: client,
        aud: ['transaction-service'],
      },
      { privateKey: pair.privateKey, kid: KID },
    );
  };
  return {
    db,
    app,
    reached,
    fraudBodies,
    notificationBodies,
    pay: (over = {}) =>
      request(app.httpServer)
        .post('/transaction')
        .set('authorization', `Bearer ${jwt('api-gateway')}`)
        .send({
          transaction_id: 'TX-1000000000001',
          idempotency_key: KEY,
          customer_token: mode === 'baseline' ? CUSTOMER_ID : TOKEN,
          account_token: mode === 'baseline' ? ACCOUNT_NUMBER : ['PSEU', '00000002'].join('-'),
          merchant_id: 'MRC-001',
          amount: 2_000_000,
          geohash: 'qqgu4',
          ...over,
        }),
    detail: (id) =>
      request(app.httpServer)
        .get(`/transaction/${id}`)
        .set('authorization', `Bearer ${jwt('reconciliation')}`),
    rows: async () =>
      (await db.owner.query<Record<string, unknown>>('SELECT * FROM transactions')).rows,
  };
}

describe('M5-02 FR-23 Transaction in baseline mode', () => {
  it('M5-02 N-44 the payment is stored under the identity, Fraud and Notification get the customer id, and Privacy is never reached', async () => {
    running = await start('baseline');
    const answer = await running.pay();
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ status: 'COMPLETED' });
    expect(await running.rows()).toMatchObject([
      { customer_id: CUSTOMER_ID, account_number: ACCOUNT_NUMBER, status: 'COMPLETED' },
    ]);
    expect(running.fraudBodies).toMatchObject([{ pseudonym: CUSTOMER_ID }]);
    expect(running.notificationBodies).toMatchObject([{ notif_token: CUSTOMER_ID }]);
    expect(running.reached).not.toContain('privacy.test');
  });

  it('M5-02 N-44 the status Privacy never heard is not left for the cleaner: the row is marked as told', async () => {
    running = await start('baseline');
    await running.pay();
    const [row] = await running.rows();
    expect(row?.['privacy_synced_at']).not.toBeNull();
  });

  it('M5-02 N-46 the detail for Reconciliation carries the account number in baseline', async () => {
    running = await start('baseline');
    await running.pay();
    const detail = await running.detail('TX-1000000000001');
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      transaction_id: 'TX-1000000000001',
      account_number: ACCOUNT_NUMBER,
    });
  });

  it('M5-02 N-44 a token in place of the identity is refused at the edge and nothing is stored', async () => {
    running = await start('baseline');
    expect((await running.pay({ customer_token: TOKEN })).status).toBe(422);
    expect((await running.pay({ account_token: TOKEN })).status).toBe(422);
    expect(await running.rows()).toEqual([]);
  });
});

describe('M5-03 FR-23 G1 G3 G6 Transaction in baseline mode receives the NIK and the name the Gateway passes on', () => {
  const person = buildCanary(54);

  // Changed with the owner's decision on Tabel IV (baseline forwards the real attributes): before, this test asserted
  // that the NIK and the name were kept nowhere and handed to no one.
  it('M5-03 G1 G3 G6 the payment is accepted with them, kept in the baseline row and handed to Fraud, and to no one else', async () => {
    running = await start('baseline');
    const answer = await running.pay({ nik: person.nik, nama: person.nama });
    expect(answer.status).toBe(201);
    expect(await running.rows()).toMatchObject([{ nik: person.nik, nama: person.nama }]);
    expect(running.fraudBodies).toMatchObject([
      {
        pseudonym: CUSTOMER_ID,
        nik: person.nik,
        nama: person.nama,
        account_number: ACCOUNT_NUMBER,
      },
    ]);
    expect(JSON.stringify(running.notificationBodies)).not.toContain(person.nik);
    expect(JSON.stringify(running.notificationBodies)).not.toContain(person.nama);
  });

  it('M5-03 G1 S-40 a field outside the list, the email among them, is still refused and nothing is stored', async () => {
    running = await start('baseline');
    expect((await running.pay({ email: person.email })).status).toBe(422);
    expect((await running.pay({ hp: person.hp })).status).toBe(422);
    expect(await running.rows()).toEqual([]);
  });
});

describe('M5-02 FR-23 Transaction in proposed mode', () => {
  it('M5-03 G1 the schema of proposed stays strict: a NIK or a name is refused and nothing is stored', async () => {
    const person = buildCanary(54);
    running = await start('proposed');
    expect((await running.pay({ nik: person.nik })).status).toBe(422);
    expect((await running.pay({ nama: person.nama })).status).toBe(422);
    expect(await running.rows()).toEqual([]);
  });

  it('M5-02 N-44 an identifier in place of a token is refused at the edge and nothing is stored', async () => {
    running = await start('proposed');
    expect((await running.pay({ customer_token: CUSTOMER_ID })).status).toBe(422);
    expect((await running.pay({ account_token: ACCOUNT_NUMBER })).status).toBe(422);
    expect(await running.rows()).toEqual([]);
  });
});

describe('M5-02 ADR-0006 an inconsistent environment does not start', () => {
  const startsWith = (mode: PrivacyMode, over: Record<string, string | undefined>) =>
    createServiceApp(
      { service: 'transaction-service', modules: transactionModules() },
      envFor(mode, over),
    ).then(
      async (app) => {
        await app.close();
        return undefined;
      },
      (error: unknown) => error as Error,
    );

  it('M5-02 baseline with PRIVACY_SERVICE_URL does not start and names only the variable', async () => {
    const error = await startsWith('baseline', { PRIVACY_SERVICE_URL: 'http://privacy.test' });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('PRIVACY_SERVICE_URL');
  });

  it('M5-02 proposed without PRIVACY_SERVICE_URL does not start and names only the variable', async () => {
    const error = await startsWith('proposed', { PRIVACY_SERVICE_URL: undefined });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('PRIVACY_SERVICE_URL');
  });
});
