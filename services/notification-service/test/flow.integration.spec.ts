import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  safeEqual,
  signJwt,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { privacyModules } from '../../privacy-service/src/privacy.module';
import { smsSimulatorModules } from '../../sms-simulator/src/sms-simulator.module';
import { notificationModules } from '../src/notification.module';

// Seam: the whole path of a notification with nothing faked but the network and the IdP: the real Privacy Service on its
// database, the real Notification Service on its database, and the real SMS simulator. The registration of a contact
// (flow A4) and a payment's message (B7..B10) go in, and the scan of spec pengujian 6 looks at what each left behind: the
// phone must be in contact_registry and in the simulator, and nowhere else (D-08, E(s) of Notification is 1/6).
// Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const privacyMigrations = join(__dirname, '..', '..', 'privacy-service', 'migrations');
const notificationMigrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'notification-flow-test';
const ISSUER = 'privpay-dev-idp';
const SECRET = 'fake-secret-notification-0123456789abcdef';
const person = buildCanary(51);
const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');

let privacyDb: TestDb;
let notificationDb: TestDb;
let clock: FakeClock;
let privacy: ServiceApp | undefined;
let notification: ServiceApp;
let simulator: ServiceApp;
let dir: string;
let smsCalls = 0;
const logs: Record<'privacy' | 'notification' | 'simulator', string[]> = {
  privacy: [],
  notification: [],
  simulator: [],
};

const sign = (azp: string, aud: string[]): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub: azp, azp, aud },
    { privateKey: pair.privateKey, kid: KID },
  );
};
const person_ = (role: string): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    {
      iss: ISSUER,
      iat,
      exp: iat + 300,
      jti: 'fake-jti',
      sub: `usr-${role}`,
      azp: 'admin-console',
      aud: ['api-gateway', 'privacy-service', 'reconciliation-service'],
      roles: [role],
    },
    { privateKey: pair.privateKey, kid: KID },
  );
};

/** The network as the services see it: the IdP is a stub, the other hosts are the real apps of this test. */
const network: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (url.hostname === 'idp.test') {
    if (url.pathname === '/.well-known/jwks.json') {
      const jwk = {
        ...pair.publicKey.export({ format: 'jwk' }),
        kid: KID,
        alg: 'RS256',
        use: 'sig',
      };
      return json(200, { keys: [jwk] });
    }
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      client_id: string;
      client_secret: string;
      audience: string[];
    };
    if (body.client_id !== 'notification' || !safeEqual(body.client_secret, SECRET)) {
      return json(401, { error: { code: 'UNAUTHENTICATED' } });
    }
    return json(200, {
      access_token: sign(body.client_id, body.audience),
      token_type: 'Bearer',
      expires_in: 300,
    });
  }
  if (url.hostname === 'sms.test') smsCalls += 1;
  const target = url.hostname === 'privacy.test' ? privacy : simulator;
  if (target === undefined) throw new TypeError('connection refused to ' + url.hostname);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const method = (init?.method ?? 'GET').toLowerCase() as 'get' | 'post' | 'patch';
  const call = request(target.httpServer)[method](url.pathname);
  const answer = await call
    .set(headers)
    .send(typeof init?.body === 'string' ? (JSON.parse(init.body) as object) : {});
  return new Response(answer.text === '' ? null : answer.text, {
    status: answer.status,
    headers: { 'content-type': 'application/json' },
  });
};

beforeEach(async () => {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  logs.privacy = [];
  logs.notification = [];
  logs.simulator = [];
  smsCalls = 0;
  privacyDb = await createTestDb(pg, { service: 'privacy', suffix: 'm405p' });
  await migrate(privacyDb.owner, { root: privacyMigrations, mode: 'proposed' });
  notificationDb = await createTestDb(pg, { service: 'notification', suffix: 'm405f' });
  await migrate(notificationDb.owner, { root: notificationMigrations, mode: 'proposed' });
  dir = mkdtempSync(join(tmpdir(), 'privpay-notification-flow-'));
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${hex(byte)}\n`);
  }
  writeFileSync(join(dir, 'notification_client_secret'), `${SECRET}\n`);

  simulator = await createServiceApp(
    { service: 'sms-simulator', modules: smsSimulatorModules({ fetch: network }) },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: ISSUER,
      SMS_SIMULATOR_TEST_ENDPOINTS: 'true',
    },
    { clock, logDestination: { write: (line) => void logs.simulator.push(line) } },
  );
  privacy = await createServiceApp(
    {
      service: 'privacy-service',
      modules: privacyModules({
        fetch: network,
        pools: {
          app: privacyDb.app,
          ...(privacyDb.auditor === undefined ? {} : { auditor: privacyDb.auditor }),
        },
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
      DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
      PSEUDONYM_KEY_VERSION: '1',
      PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
      BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
      FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
    },
    { clock, logDestination: { write: (line) => void logs.privacy.push(line) } },
  );
  notification = await createServiceApp(
    {
      service: 'notification-service',
      modules: notificationModules({ fetch: network, pools: { app: notificationDb.app } }),
    },
    {
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
    },
    { clock, logDestination: { write: (line) => void logs.notification.push(line) } },
  );
});
afterEach(async () => {
  await notification.close();
  await privacy?.close();
  privacy = undefined;
  await simulator.close();
  rmSync(dir, { recursive: true, force: true });
  await notificationDb.close();
  await privacyDb.close();
});

const toPrivacy = (client: string, body: object) =>
  request((privacy as ServiceApp).httpServer)
    .post('/pseudonymize')
    .set('authorization', `Bearer ${sign(client, ['privacy-service'])}`)
    .send(body);
const toNotification = (client: string, path: string, body: object) =>
  request(notification.httpServer)
    .post(path)
    .set('authorization', `Bearer ${sign(client, ['notification-service'])}`)
    .send(body);
const messages = async () =>
  (await request(simulator.httpServer).get('/__test/messages')).body as {
    messages: { to: string; text: string }[];
  };

/** A4: the Gateway issues the domain token (P5) and registers the phone under it. */
async function registered(): Promise<string> {
  const p5 = await toPrivacy('api-gateway', {
    subject_type: 'CUSTOMER',
    subject_id: person.customer_id,
    target_service: 'NOTIFICATION',
    purpose: 'NOTIFICATION_REGISTRATION',
  });
  expect(p5.status).toBe(200);
  const domain = (p5.body as { pseudonym: string }).pseudonym;
  const stored = await toNotification('api-gateway', '/notification/register', {
    notification_domain_id: domain,
    phone: person.hp,
    channel: 'SMS',
  });
  expect(stored.status).toBe(201);
  return domain;
}
/** B1 and B7: the Gateway issues P1, Transaction trades it for the token Notification may resolve (P4). */
async function notifToken(transactionId = 'TX-9001'): Promise<string> {
  const p1 = await toPrivacy('api-gateway', {
    subject_type: 'CUSTOMER',
    subject_id: person.customer_id,
    target_service: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transaction_id: transactionId,
  });
  const p4 = await toPrivacy('transaction', {
    source_pseudonym: (p1.body as { pseudonym: string }).pseudonym,
    target_service: 'NOTIFICATION',
    purpose: 'NOTIFICATION',
    transaction_id: transactionId,
  });
  expect(p4.status).toBe(200);
  return (p4.body as { pseudonym: string }).pseudonym;
}
const send = (token: string, over: Record<string, unknown> = {}) =>
  toNotification('transaction', '/notification/send', {
    notif_token: token,
    template: 'TX_COMPLETED',
    amount: 35000,
    transaction_id: 'TX-9001',
    ...over,
  });

describe('M4-05 TF-01 TF-02 FR-08 the path of a notification on the real services', () => {
  it('M4-05 TF-02 FR-08 a payment of a registered customer is delivered to the simulator, resolved through Privacy', async () => {
    await registered();
    const answer = await send(await notifToken());
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'SENT' });
    expect(await messages()).toEqual({
      messages: [{ to: person.hp, text: 'Transaksi Rp35000 berhasil.' }],
    });
    const log = await notificationDb.owner.query(
      'SELECT status, template, channel FROM notification_log',
    );
    expect(log.rows).toEqual([{ status: 'SENT', template: 'TX_COMPLETED', channel: 'SMS' }]);
  });

  it('M4-05 FR-20 TF-02 a customer who never registered gets FAILED, and nothing reaches the simulator', async () => {
    const answer = await send(await notifToken());
    expect(answer.body).toEqual({ status: 'FAILED' });
    expect((await messages()).messages).toEqual([]);
  });

  it('M4-05 FR-20 TF-02 a simulator that refuses the message is FAILED with one FAILED row, and the SMS is asked once, never again', async () => {
    await registered();
    const token = await notifToken();
    await simulator.close();
    simulator = await createServiceApp(
      { service: 'sms-simulator', modules: smsSimulatorModules({ fetch: network }) },
      {
        PRIVACY_MODE: 'proposed',
        PORT: '0',
        IDP_URL: 'http://idp.test',
        IDP_ISSUER: ISSUER,
        SMS_SIMULATOR_TEST_ENDPOINTS: 'true',
        SMS_SIMULATOR_FAIL: 'true',
      },
      { clock, logDestination: { write: (line) => void logs.simulator.push(line) } },
    );
    expect((await send(token)).body).toEqual({ status: 'FAILED' });
    expect(smsCalls).toBe(1);
    expect((await messages()).messages).toEqual([]);
    const log = await notificationDb.owner.query('SELECT status FROM notification_log');
    expect(log.rows).toEqual([{ status: 'FAILED' }]);
  });

  it('M4-05 FR-20 a token Privacy has revoked is FAILED: Notification cannot get around Privacy', async () => {
    await registered();
    const token = await notifToken();
    const revoked = await request((privacy as ServiceApp).httpServer)
      .post(`/pseudonym/${token}/revoke`)
      .set('authorization', `Bearer ${person_('admin')}`)
      .send({});
    expect(revoked.status).toBe(200);
    expect((await send(token)).body).toEqual({ status: 'FAILED' });
    expect((await messages()).messages).toEqual([]);
  });

  it('M4-05 FR-20 invariant 8 with Privacy away the message is FAILED, not sent around Privacy', async () => {
    await registered();
    const token = await notifToken();
    await (privacy as ServiceApp).close();
    privacy = undefined;
    expect((await send(token)).body).toEqual({ status: 'FAILED' });
    expect((await messages()).messages).toEqual([]);
  });

  it('M4-05 FR-20 a token that is not the notification token of this service is FAILED (P1 is not for Notification)', async () => {
    await registered();
    const p1 = await toPrivacy('api-gateway', {
      subject_type: 'CUSTOMER',
      subject_id: person.customer_id,
      target_service: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transaction_id: 'TX-9002',
    });
    const answer = await send((p1.body as { pseudonym: string }).pseudonym);
    expect(answer.body).toEqual({ status: 'FAILED' });
    expect((await messages()).messages).toEqual([]);
  });
});

describe('M4-05 D-08 S-43 E(s) the phone is in two places only', () => {
  it('M4-05 D-08 the scan finds the phone in contact_registry and the simulator, and in no other table, answer or log', async () => {
    const domain = await registered();
    const token = await notifToken();
    const answers = [await send(token), await send(token, { template: 'TX_REJECTED' })];

    // Where it must be.
    expect(await scanDatabase(notificationDb.owner, [person], 'notification')).toEqual([
      { attribute: 'hp', location: 'contact_registry.phone', service: 'notification' },
    ]);
    expect(JSON.stringify(await messages())).toContain(person.hp);

    // Where it must not be.
    assertNoFindings(await scanDatabase(privacyDb.owner, [person], 'privacy'));
    const audit = await privacyDb.owner.query('SELECT * FROM audit_log');
    assertNoFindings(
      scanText(JSON.stringify(audit.rows), [person], { service: 'privacy', location: 'audit_log' }),
    );
    for (const service of ['privacy', 'notification', 'simulator'] as const) {
      assertNoFindings(scanText(logs[service].join('\n'), [person], { service, location: 'log' }));
    }
    assertNoFindings(
      scanText(JSON.stringify(answers.map((answer): unknown => answer.body)), [person], {
        service: 'notification',
        location: 'response',
      }),
    );
    // Notification only ever learns the domain token, which is not the customer.
    expect(domain).toMatch(/^PSEU-[0-9A-F]{8}$/);
  });

  it('M4-05 D-08 the scan can fail: a phone written into the log table of Notification is found', async () => {
    await notificationDb.owner.query(
      `INSERT INTO notification_log (sender_pseudonym, recipient_pseudonym, template, channel, status)
       VALUES ('PSEU-00000001', $1, 'TX_COMPLETED', 'SMS', 'SENT')`,
      [person.hp.slice(0, 16)],
    );
    const findings = await scanDatabase(notificationDb.owner, [person], 'notification');
    expect(findings.map((finding) => finding.location)).toContain(
      'notification_log.recipient_pseudonym',
    );
  });
});
