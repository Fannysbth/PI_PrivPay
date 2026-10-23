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
import { notificationModules } from '../src/notification.module';

// Seam: the notification routes in each mode, with the service's real module over the database of that mode (M5-02,
// ADR-0006, N-44). Proposed resolves the notification token at Privacy; baseline takes the customer id as it is and does
// not call Privacy at all. Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'notification-mode-test';
const ISSUER = 'privpay-dev-idp';
const TOKEN = ['PSEU', 'D0A1B2C3'].join('-');
const CUSTOMER_ID = ['CUST', '000101'].join('-');
const PHONE = '081200000042';

let dir: string;
let running: Running | undefined;

interface Running {
  readonly db: TestDb;
  readonly app: ServiceApp;
  readonly sent: { to: string; text: string }[];
  readonly reached: string[];
  post(path: string, caller: string, payload: unknown): Promise<request.Response>;
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
  ...(mode === 'proposed' ? { PRIVACY_SERVICE_URL: 'http://privacy.test' } : {}),
  SMS_SIMULATOR_URL: 'http://sms.test',
  NOTIFICATION_CLIENT_SECRET_FILE: join(dir, 'notification_client_secret'),
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-notification-mode-'));
  writeFileSync(
    join(dir, 'notification_client_secret'),
    'fake-secret-notification-0123456789abcdef\n',
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
  const db = await createTestDb(pg, { service: 'notification', suffix: `m502${mode.slice(0, 1)}` });
  await migrate(db.owner, { root: migrations, mode });
  const reached: string[] = [];
  const sent: { to: string; text: string }[] = [];
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const fetchStub: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    reached.push(new URL(url).hostname);
    return Promise.resolve(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const app = await createServiceApp(
    {
      service: 'notification-service',
      // No privacy override: whichever adapter the mode builds is the one that answers.
      modules: notificationModules({
        fetch: fetchStub,
        pools: { app: db.app },
        sms: {
          send: (to, text) => {
            sent.push({ to, text });
            return Promise.resolve();
          },
        },
      }),
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
        aud: ['notification-service'],
      },
      { privateKey: pair.privateKey, kid: KID },
    );
  };
  return {
    db,
    app,
    sent,
    reached,
    post: (path, caller, payload) =>
      request(app.httpServer)
        .post(path)
        .set('authorization', `Bearer ${jwt(caller)}`)
        .send(payload as object),
    rows: async () =>
      (await db.owner.query<Record<string, unknown>>('SELECT * FROM contact_registry')).rows,
  };
}

const register = (reference: string) => ({
  notification_domain_id: reference,
  phone: PHONE,
  channel: 'SMS',
});
const send = (reference: string) => ({
  notif_token: reference,
  template: 'TX_COMPLETED',
  amount: 35_000,
  transaction_id: 'TX-10001',
});

describe('M5-02 FR-23 Notification in baseline mode', () => {
  it('M5-02 N-44 the contact is registered under the customer id and a message reaches the phone without any call to Privacy', async () => {
    running = await start('baseline');
    const registered = await running.post(
      '/notification/register',
      'api-gateway',
      register(CUSTOMER_ID),
    );
    expect(registered.status).toBe(201);
    expect(await running.rows()).toMatchObject([{ customer_id: CUSTOMER_ID }]);
    const answer = await running.post('/notification/send', 'transaction', send(CUSTOMER_ID));
    expect(answer.status).toBe(200);
    expect(running.sent).toEqual([{ to: PHONE, text: 'Transaksi Rp35000 berhasil.' }]);
    expect(running.reached).not.toContain('privacy.test');
  });

  it('M5-02 N-44 a token is refused at the edge in both routes and nothing is stored or sent', async () => {
    running = await start('baseline');
    expect(
      (await running.post('/notification/register', 'api-gateway', register(TOKEN))).status,
    ).toBe(422);
    expect((await running.post('/notification/send', 'transaction', send(TOKEN))).status).toBe(422);
    expect(await running.rows()).toEqual([]);
    expect(running.sent).toEqual([]);
  });
});

describe('M5-02 FR-23 Notification in proposed mode', () => {
  it('M5-02 N-44 a customer id is refused at the edge in both routes', async () => {
    running = await start('proposed');
    expect(
      (await running.post('/notification/register', 'api-gateway', register(CUSTOMER_ID))).status,
    ).toBe(422);
    expect(
      (await running.post('/notification/send', 'transaction', send(CUSTOMER_ID))).status,
    ).toBe(422);
  });
});

describe('M5-02 ADR-0006 an inconsistent environment does not start', () => {
  const startsWith = (mode: PrivacyMode, over: Record<string, string | undefined>) =>
    createServiceApp(
      { service: 'notification-service', modules: notificationModules() },
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
