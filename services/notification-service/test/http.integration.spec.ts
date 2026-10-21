import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DomainError,
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  signJwt,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { notificationModules } from '../src/notification.module';

// Seam: the notification routes over HTTP, with the service's real module on the real database, the IdP's keys served
// by a stub, and fake Privacy and SMS adapters (AZ-32, AZ-33, spec notification 3). The numbers and tokens are invented.
// Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'notification-http-test';
const ISSUER = 'privpay-dev-idp';
const DOMAIN = 'PSEU-D0A1B2C3';
const PHONE = '081200000042';

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;
let dir: string;
let logLines: string[];
let sent: { to: string; text: string }[];
let privacyFails: boolean;

const jwt = (client: string, aud = ['notification-service']): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub: client, azp: client, aud },
    { privateKey: pair.privateKey, kid: KID },
  );
};

const baseEnv = (): Record<string, string> => ({
  PRIVACY_MODE: 'proposed',
  PORT: '0',
  PG_HOST: pg.PG_HOST,
  PG_PORT: String(pg.PG_PORT),
  PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: ISSUER,
  PRIVACY_SERVICE_URL: 'http://privacy.test',
  SMS_SIMULATOR_URL: 'http://sms.test',
  NOTIFICATION_CLIENT_SECRET_FILE: join(dir, 'notification_client_secret'),
});

beforeEach(async () => {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  dir = mkdtempSync(join(tmpdir(), 'privpay-notification-'));
  writeFileSync(
    join(dir, 'notification_client_secret'),
    'fake-secret-notification-0123456789abcdef\n',
  );
  db = await createTestDb(pg, { service: 'notification', suffix: 'm405h' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  logLines = [];
  sent = [];
  privacyFails = false;
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
      service: 'notification-service',
      modules: notificationModules({
        fetch: fetchStub,
        pools: { app: db.app },
        privacy: {
          resolveDomain: () =>
            privacyFails
              ? Promise.reject(new DomainError('SERVICE_UNAVAILABLE'))
              : Promise.resolve(DOMAIN),
        },
        sms: {
          send: (to, text) => {
            sent.push({ to, text });
            return Promise.resolve();
          },
        },
      }),
    },
    baseEnv(),
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  await db.close();
});

const post = (path: string, token: string | undefined, payload: unknown) => {
  const call = request(app.httpServer)
    .post(path)
    .send(payload as object);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};
const registerBody = (over: Record<string, unknown> = {}) => ({
  notification_domain_id: DOMAIN,
  phone: PHONE,
  channel: 'SMS',
  ...over,
});
const sendBody = (over: Record<string, unknown> = {}) => ({
  notif_token: 'PSEU-1111AAAA',
  template: 'TX_COMPLETED',
  amount: 35000,
  transaction_id: 'TX-1000000000001',
  ...over,
});
const gateway = () => jwt('api-gateway');
const transaction = () => jwt('transaction');
const contacts = async (): Promise<number> =>
  (await db.owner.query('SELECT 1 FROM contact_registry')).rowCount ?? 0;
const logRows = async (): Promise<number> =>
  (await db.owner.query('SELECT 1 FROM notification_log')).rowCount ?? 0;

describe('M4-05 AZ-32 POST /notification/register', () => {
  it('M4-05 AZ-32 N1 no credential or an expired token is 401 and stores nothing', async () => {
    expect((await post('/notification/register', undefined, registerBody())).status).toBe(401);
    const old = gateway();
    clock.advance(301);
    expect((await post('/notification/register', old, registerBody())).status).toBe(401);
    expect(await contacts()).toBe(0);
  });

  it.each([['transaction'], ['fraud'], ['reconciliation'], ['notification']])(
    'M4-05 AZ-32 N2 the service %s is POLICY_NOT_ALLOWED and stores nothing',
    async (client) => {
      const answer = await post('/notification/register', jwt(client), registerBody());
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(await contacts()).toBe(0);
    },
  );

  it('M4-05 AZ-32 N3 an unknown field is 422 and stores nothing', async () => {
    expect(
      (await post('/notification/register', gateway(), registerBody({ extra: 1 }))).status,
    ).toBe(422);
    expect(await contacts()).toBe(0);
  });

  it.each([['customer_id'], ['nik'], ['nama'], ['email'], ['rekening'], ['requesting_service']])(
    'M4-05 AZ-32 N4 the field %s in the body is 422: no identity and no claim of who calls',
    async (field) => {
      const answer = await post(
        '/notification/register',
        gateway(),
        registerBody({ [field]: 'x' }),
      );
      expect(answer.status).toBe(422);
      expect(await contacts()).toBe(0);
    },
  );

  it.each([
    ['a phone of the wrong shape', { phone: '12345' }],
    ['a phone with a plus', { phone: '+6281200000042' }],
    ['a phone with letters', { phone: '0812abcd0042' }],
    ['a channel other than SMS', { channel: 'EMAIL' }],
    ['a lower-case channel', { channel: 'sms' }],
    ['a domain id that is a customer id', { notification_domain_id: 'CUST-000101' }],
    ['a missing phone', { phone: undefined }],
  ])('M4-05 FR-19 %s is 422 and stores nothing', async (_name, over) => {
    const answer = await post('/notification/register', gateway(), registerBody(over));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { reason: 'VALIDATION_ERROR' } });
    expect(await contacts()).toBe(0);
  });

  it('M4-05 FR-19 TF-01 the first registration is 201, the repeat is 200 with the same shape and the new phone', async () => {
    const first = await post('/notification/register', gateway(), registerBody());
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      notification_domain_id: DOMAIN,
      registered_at: '2026-10-20T08:00:00.000Z',
    });
    clock.advance(60);
    const again = await post(
      '/notification/register',
      gateway(),
      registerBody({ phone: '081200000043' }),
    );
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await contacts()).toBe(1);
    const stored = await db.owner.query<{ phone: string }>('SELECT phone FROM contact_registry');
    expect(stored.rows[0]?.phone).toBe('081200000043');
    // The answer never gives the phone back.
    expect(JSON.stringify(first.body)).not.toContain(PHONE);
  });
});

describe('M4-05 AZ-33 POST /notification/send', () => {
  it('M4-05 AZ-33 N1 no credential or an expired token is 401 and sends nothing', async () => {
    expect((await post('/notification/send', undefined, sendBody())).status).toBe(401);
    const old = transaction();
    clock.advance(301);
    expect((await post('/notification/send', old, sendBody())).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it.each([['api-gateway'], ['fraud'], ['reconciliation'], ['notification']])(
    'M4-05 AZ-33 N2 the service %s is POLICY_NOT_ALLOWED and sends nothing',
    async (client) => {
      await post('/notification/register', gateway(), registerBody());
      const answer = await post('/notification/send', jwt(client), sendBody());
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(sent).toEqual([]);
      expect(await logRows()).toBe(0);
    },
  );

  it('M4-05 AZ-33 N3 an unknown field is 422 and sends nothing', async () => {
    await post('/notification/register', gateway(), registerBody());
    expect((await post('/notification/send', transaction(), sendBody({ extra: 1 }))).status).toBe(
      422,
    );
    expect(sent).toEqual([]);
  });

  it.each([
    ['customer_id'],
    ['phone'],
    ['text'],
    ['nama'],
    ['requesting_service'],
    ['notification_domain_id'],
  ])(
    'M4-05 AZ-33 N4 the field %s in the body is 422: only a token comes in, never a phone, a text or an identity',
    async (field) => {
      await post('/notification/register', gateway(), registerBody());
      const answer = await post('/notification/send', transaction(), sendBody({ [field]: 'x' }));
      expect(answer.status).toBe(422);
      expect(sent).toEqual([]);
    },
  );

  it.each([
    ['an unknown template', { template: 'TX_ANYTHING' }],
    ['a free text as template', { template: 'Halo' }],
    ['amount 0', { amount: 0 }],
    ['amount fractional', { amount: 1.5 }],
    ['amount as text', { amount: '35000' }],
    ['a token of the wrong shape', { notif_token: 'CUST-000101' }],
    ['a transaction id of the wrong shape', { transaction_id: 'trx 1' }],
    ['a missing amount', { amount: undefined }],
  ])('M4-05 FR-08 %s is 422 and sends nothing', async (_name, over) => {
    await post('/notification/register', gateway(), registerBody());
    const answer = await post('/notification/send', transaction(), sendBody(over));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { reason: 'VALIDATION_ERROR' } });
    expect(sent).toEqual([]);
  });

  it('M4-05 FR-08 TF-02 Transaction gets 200 SENT and the SMS went to the registered phone with the fixed text', async () => {
    await post('/notification/register', gateway(), registerBody());
    const answer = await post('/notification/send', transaction(), sendBody());
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'SENT' });
    expect(sent).toEqual([{ to: PHONE, text: 'Transaksi Rp35000 berhasil.' }]);
  });

  it('M4-05 FR-20 a failure is 200 FAILED, not an error: Transaction is completed whatever happens here', async () => {
    await post('/notification/register', gateway(), registerBody());
    privacyFails = true;
    const answer = await post('/notification/send', transaction(), sendBody());
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'FAILED' });
    expect(sent).toEqual([]);
  });

  it('M4-05 D-08 NFR-15 the log of the calls carries no phone, no text and no amount', async () => {
    await post('/notification/register', gateway(), registerBody());
    await post('/notification/send', transaction(), sendBody({ amount: 8_123_456 }));
    await post('/notification/register', gateway(), registerBody({ phone: '12345' }));
    const log = logLines.join(' ');
    for (const value of [
      PHONE,
      '12345',
      'Transaksi',
      '8123456',
      '35000',
      'PSEU-1111AAAA',
      DOMAIN,
    ]) {
      expect(log).not.toContain(value);
    }
  });
});

describe('M4-05 the start needs its settings', () => {
  it.each([
    ['PRIVACY_SERVICE_URL'],
    ['SMS_SIMULATOR_URL'],
    ['NOTIFICATION_CLIENT_SECRET_FILE'],
    ['IDP_URL'],
  ])('M4-05 without %s the service does not start and names only the variable', async (name) => {
    const without: Record<string, string | undefined> = { ...baseEnv(), [name]: undefined };
    const error = await createServiceApp(
      { service: 'notification-service', modules: notificationModules({ pools: { app: db.app } }) },
      without,
    ).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(name.replace('_FILE', ''));
    expect((error as Error).message).not.toContain('fake-secret-notification');
  });
});
