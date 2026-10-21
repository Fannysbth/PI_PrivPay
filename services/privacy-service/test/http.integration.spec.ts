import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPool,
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  signJwt,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { privacyModules } from '../src/privacy.module';

// Seam: the HTTP layer of the privacy service on the real database, with a fake clock and a fake IdP (the JWKS).
// Every key, secret, token and identifier is invented for the run. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'privacy-http-test';
const ISSUER = 'privpay-dev-idp';
const START = '2026-10-20T08:00:00.000Z';
const CUSTOMER = 'CUST-000101';

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;
let dir: string;
let jwksFailing = false;
let logLines: string[];

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const claimsFor = (extra: Record<string, unknown>): Record<string, unknown> => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', ...extra };
};
const service = (client: string, aud = ['privacy-service'], key = pair.privateKey): string =>
  signJwt(claimsFor({ sub: client, azp: client, aud }), { privateKey: key, kid: KID });
const person = (role: string): string =>
  signJwt(
    claimsFor({
      sub: `usr-${role}`,
      azp: 'admin-console',
      aud: ['api-gateway', 'privacy-service', 'reconciliation-service'],
      roles: [role],
    }),
    { privateKey: pair.privateKey, kid: KID },
  );
const algNone = (): string =>
  `${base64url({ alg: 'none', typ: 'JWT', kid: KID })}.${base64url(claimsFor({ sub: 'transaction', azp: 'transaction', aud: ['privacy-service'] }))}.`;
const hs256 = (): string => {
  const head = base64url({ alg: 'HS256', typ: 'JWT', kid: KID });
  const body = base64url(
    claimsFor({ sub: 'transaction', azp: 'transaction', aud: ['privacy-service'] }),
  );
  const mac = createHmac('sha256', pair.publicKey.export({ type: 'spki', format: 'pem' }))
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${mac}`;
};

const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');
async function start(pools: { app: Pool; auditor: Pool }): Promise<ServiceApp> {
  dir = mkdtempSync(join(tmpdir(), 'privpay-privacy-http-'));
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${hex(byte)}\n`);
  }
  logLines = [];
  const fetchStub: typeof fetch = () => {
    if (jwksFailing) return Promise.reject(new TypeError('connection refused to idp'));
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
    return Promise.resolve(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return createServiceApp(
    { service: 'privacy-service', modules: privacyModules({ fetch: fetchStub, pools }) },
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
      PSEUDONYM_KEY_VERSION: '1',
      PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
      BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
      FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
    },
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
}

beforeEach(async () => {
  jwksFailing = false;
  clock = new FakeClock(START);
  db = await createTestDb(pg, { service: 'privacy', suffix: 'm212' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  app = await start({ app: db.app, auditor: db.auditor });
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  await db.close();
});

const server = () => request(app.httpServer);
const post = (path: string, token: string | undefined, body: unknown, actor?: string) => {
  const call = server()
    .post(path)
    .send(body as object);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  if (actor !== undefined) void call.set('x-actor-token', actor);
  return call;
};
const count = async (table: string): Promise<number> =>
  Number((await db.owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
const lastAudit = async () =>
  (await db.owner.query('SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1'))
    .rows[0] as Record<string, unknown> | undefined;

const identityBody = (over: Record<string, unknown> = {}) => ({
  subject_type: 'CUSTOMER',
  subject_id: CUSTOMER,
  target_service: 'TRANSACTION',
  purpose: 'PAYMENT_PROCESSING',
  transaction_id: 'TX-7001',
  ...over,
});
const issueP1 = async (transactionId = 'TX-7001'): Promise<string> => {
  const answer = await post(
    '/pseudonymize',
    service('api-gateway'),
    identityBody({ transaction_id: transactionId }),
  );
  expect(answer.status).toBe(200);
  return (answer.body as { pseudonym: string }).pseudonym;
};

describe('M2-12 the callers are proven before anything is read (TK-19, invariant 7)', () => {
  const body = identityBody();
  const cases: [string, () => string | undefined][] = [
    ['no bearer token', () => undefined],
    ['alg none', algNone],
    ['HS256 signed with the public key', hs256],
    [
      'a signature by a key nobody published',
      () => service('api-gateway', ['privacy-service'], stranger.privateKey),
    ],
  ];
  it.each(cases)('M2-12 TK-19 %s is 401 and writes nothing', async (_name, token) => {
    const answer = await post('/pseudonymize', token(), body);
    expect(answer.status).toBe(401);
    expect(await count('audit_log')).toBe(0);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  it('M2-12 a token made for another service is refused', async () => {
    const answer = await post(
      '/pseudonymize',
      service('api-gateway', ['transaction-service']),
      body,
    );
    expect(answer.status).toBe(403);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  it('M2-12 a person token cannot call a service operation', async () => {
    const answer = await post('/pseudonymize', person('admin'), body);
    expect(answer.status).toBe(403);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  it('M2-12 the IdP being down is 503 and nothing is written (fail closed)', async () => {
    jwksFailing = true;
    const answer = await post('/pseudonymize', service('api-gateway'), body);
    expect(answer.status).toBe(503);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  it('M2-12 requesting_service in the body is a field nobody knows (D-16)', async () => {
    const answer = await post(
      '/pseudonymize',
      service('transaction'),
      identityBody({ requesting_service: 'API_GATEWAY' }),
    );
    expect(answer.status).toBe(422);
    expect(await count('audit_log')).toBe(0);
  });
});

describe('M2-12 POST /pseudonymize', () => {
  it('M2-12 AZ-18 the Gateway gets a token, then the same one back', async () => {
    const first = await post('/pseudonymize', service('api-gateway'), identityBody());
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      pseudonym: expect.stringMatching(/^PSEU-[0-9A-F]{8}$/) as unknown,
      expires_at: '2026-10-20T08:15:00.000Z',
      reused: false,
    });
    const second = await post('/pseudonymize', service('api-gateway'), identityBody());
    expect(second.body).toMatchObject({ reused: true });
    expect((second.body as { pseudonym: string }).pseudonym).toBe(
      (first.body as { pseudonym: string }).pseudonym,
    );
    expect(await count('pseudonym_mapping')).toBe(1);
  });

  it('M2-12 AZ-18 TK-07 rejects raw subject_id from TRANSACTION and audits the denial under that service', async () => {
    const answer = await post('/pseudonymize', service('transaction'), identityBody());
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    expect(await count('pseudonym_mapping')).toBe(0);
    expect(await lastAudit()).toMatchObject({
      status: 'DENIED',
      reason: 'POLICY_NOT_ALLOWED',
      requesting_service: 'TRANSACTION',
    });
  });

  it('M2-12 AZ-19 TRANSACTION exchanges its token; FRAUD cannot', async () => {
    const p1 = await issueP1();
    const exchange = {
      source_pseudonym: p1,
      target_service: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      transaction_id: 'TX-7001',
    };
    const denied = await post('/pseudonymize', service('fraud'), exchange);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    const ok = await post('/pseudonymize', service('transaction'), exchange);
    expect(ok.status).toBe(200);
    expect((ok.body as { pseudonym: string }).pseudonym).not.toBe(p1);
  });

  it('M2-12 AZ-20 P7 from a transaction needs an auditor behind RECONCILIATION', async () => {
    await issueP1();
    const body = {
      subject_type: 'CUSTOMER',
      transaction_id: 'TX-7001',
      target_service: 'RECONCILIATION',
      purpose: 'INTERNAL_AUDIT',
    };
    const without = await post('/pseudonymize', service('reconciliation'), body);
    expect(without.status).toBe(403);
    expect(without.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    const asAdmin = await post('/pseudonymize', service('reconciliation'), body, person('admin'));
    expect(asAdmin.status).toBe(403);
    const asAuditor = await post(
      '/pseudonymize',
      service('reconciliation'),
      body,
      person('auditor'),
    );
    expect(asAuditor.status).toBe(200);
    expect(await lastAudit()).toMatchObject({
      status: 'SUCCESS',
      requesting_service: 'RECONCILIATION',
    });
  });

  it.each([
    ['an unknown field', identityBody({ extra: 1 })],
    ['two forms at once', identityBody({ source_pseudonym: 'PSEU-00000001' })],
    ['a subject id of the wrong type', identityBody({ subject_id: 101 })],
    ['a transaction id that is not one', identityBody({ transaction_id: 'tx 1' })],
    ['an empty body', {}],
  ])('M2-12 %s is 422 and is not audited', async (_name, body) => {
    const answer = await post('/pseudonymize', service('api-gateway'), body);
    expect(answer.status).toBe(422);
    expect(await count('audit_log')).toBe(0);
  });

  it('M2-12 K-12 a body over 16 KiB is 422', async () => {
    const answer = await post(
      '/pseudonymize',
      service('api-gateway'),
      identityBody({ transaction_id: `TX-${'1'.repeat(17_000)}` }),
    );
    expect(answer.status).toBe(422);
  });

  it('M2-12 the log lines carry neither the subject nor a token', async () => {
    const token = service('api-gateway');
    await post('/pseudonymize', token, identityBody());
    const log = logLines.join('\n');
    expect(log).not.toContain(CUSTOMER);
    expect(log).not.toContain(token);
  });
});

describe('M2-12 POST /re-issue and PATCH /transaction-status', () => {
  it('M2-12 AZ-23 TRANSACTION re-issues an expired token; FRAUD gets POLICY_NOT_ALLOWED', async () => {
    const p1 = await issueP1();
    clock.advance(901);
    const body = { pseudonym: p1, transaction_id: 'TX-7001' };
    const denied = await post('/re-issue', service('fraud'), body);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    const ok = await post('/re-issue', service('transaction'), body);
    expect(ok.status).toBe(200);
    expect((ok.body as { pseudonym: string }).pseudonym).not.toBe(p1);
  });

  it('M2-12 AZ-24 TRANSACTION sets a status; NOTIFICATION cannot; a terminal one stays', async () => {
    const path = '/transaction-status';
    const patch = (token: string, status: string) =>
      server()
        .patch(path)
        .set('authorization', `Bearer ${token}`)
        .send({ transaction_id: 'TX-7001', status });
    expect((await patch(service('notification'), 'COMPLETED')).status).toBe(403);
    const ok = await patch(service('transaction'), 'COMPLETED');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ transaction_id: 'TX-7001', status: 'COMPLETED' });
    const other = await patch(service('transaction'), 'FAILED');
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { reason: 'TX_TERMINAL' } });
    expect(await count('audit_log')).toBe(0);
  });

  it('M2-12 a status outside the five is 422', async () => {
    const answer = await server()
      .patch('/transaction-status')
      .set('authorization', `Bearer ${service('transaction')}`)
      .send({ transaction_id: 'TX-7001', status: 'DONE' });
    expect(answer.status).toBe(422);
  });
});

describe('M2-12 the database being away is 503 (invariant 8)', () => {
  it('M2-12 no connection: 503, no raw data in the answer', async () => {
    await app.close();
    const dead = createPool(
      { ...pg, PG_HOST: '127.0.0.1', PG_PORT: 1 },
      { role: 'privpay_app', database: 'privpay_privacy' },
    );
    app = await start({ app: dead, auditor: dead });
    const answer = await post('/pseudonymize', service('api-gateway'), identityBody());
    await dead.end();
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain(CUSTOMER);
  });

  it('M2-12 health needs no token', async () => {
    expect((await server().get('/health')).status).toBe(200);
  });
});
