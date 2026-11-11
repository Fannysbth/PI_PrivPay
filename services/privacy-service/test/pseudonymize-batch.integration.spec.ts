import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { privacyModules } from '../src/privacy.module';

// ADR-0019: POST /pseudonymize/batch. Seam: the HTTP layer of the privacy service on the real database, with a fake clock and a fake IdP (the JWKS).
// Every key, secret, token and identifier is invented for the run. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'privacy-batch-test';
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
const person = (role: string, sub = `usr-${role}`): string =>
  signJwt(
    claimsFor({
      sub,
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
  dir = mkdtempSync(join(tmpdir(), 'privpay-privacy-batch-'));
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
      DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
      RETENTION_DAYS: '90',
      RETENTION_JOB_RUN_UTC: '01:00',
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
  db = await createTestDb(pg, { service: 'privacy', suffix: 'adr19' });
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

const ACCOUNT = '90000000001';
const element = (over: Record<string, unknown> = {}) => ({
  subject_type: 'CUSTOMER',
  subject_id: CUSTOMER,
  target_service: 'TRANSACTION',
  purpose: 'PAYMENT_PROCESSING',
  transaction_id: 'TX-7001',
  ...over,
});
const accountElement = (over: Record<string, unknown> = {}) =>
  element({ subject_type: 'ACCOUNT', subject_id: ACCOUNT, ...over });
const pair2 = (): Record<string, unknown>[] => [element(), accountElement()];
const batch = (token: string | undefined, requests: unknown) =>
  post('/pseudonymize/batch', token, { requests });
interface Item {
  pseudonym: string;
  reused: boolean;
}
const itemsOf = (answer: { body: unknown }): Item[] => (answer.body as { items: Item[] }).items;
const auditRows = async () =>
  (
    await db.owner.query(
      'SELECT action, status, reason, requesting_service FROM audit_log ORDER BY created_at, id',
    )
  ).rows as { action: string; status: string; reason: string; requesting_service: string }[];

describe('ADR-0019 POST /pseudonymize/batch', () => {
  it('ADR-0019 two elements give two tokens in order, two mappings and exactly two SUCCESS rows', async () => {
    const answer = await batch(service('api-gateway'), pair2());
    expect(answer.status).toBe(200);
    const items = itemsOf(answer);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.reused)).toEqual([false, false]);
    expect(items[0]?.pseudonym).not.toBe(items[1]?.pseudonym);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(['expires_at', 'pseudonym', 'reused']);
    // The answer never carries the subject (privacy spec 4.1): not the customer id, not the account.
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(CUSTOMER);
    expect(text).not.toContain(ACCOUNT);
    expect(await count('pseudonym_mapping')).toBe(2);
    const ok = {
      action: 'GENERATE_TOKEN',
      status: 'SUCCESS',
      reason: 'OK',
      requesting_service: 'API_GATEWAY',
    };
    expect(await auditRows()).toEqual([ok, ok]);
  });

  it('ADR-0019 the same tokens as the single route, and a repeat gives them back as REUSED_ACTIVE', async () => {
    const single = await post('/pseudonymize', service('api-gateway'), accountElement());
    const first = await batch(service('api-gateway'), pair2());
    const again = await batch(service('api-gateway'), pair2());
    expect(itemsOf(first)[1]?.pseudonym).toBe((single.body as { pseudonym: string }).pseudonym);
    expect(itemsOf(again).map((item) => item.pseudonym)).toEqual(
      itemsOf(first).map((item) => item.pseudonym),
    );
    expect(itemsOf(again).map((item) => item.reused)).toEqual([true, true]);
    expect(await count('pseudonym_mapping')).toBe(2);
    expect(await count('audit_log')).toBe(5);
  });

  it('ADR-0019 one element is allowed too', async () => {
    const answer = await batch(service('api-gateway'), [element()]);
    expect(answer.status).toBe(200);
    expect(itemsOf(answer)).toHaveLength(1);
    expect(await count('audit_log')).toBe(1);
  });

  it('ADR-0019 two batches at once do not deadlock and agree on the tokens', async () => {
    const [one, two] = await Promise.all([
      batch(service('api-gateway'), pair2()),
      batch(service('api-gateway'), pair2()),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(itemsOf(one).map((item) => item.pseudonym)).toEqual(
      itemsOf(two).map((item) => item.pseudonym),
    );
    expect(await count('pseudonym_mapping')).toBe(2);
    expect(await count('audit_log')).toBe(4);
  });
});

describe('ADR-0019 lock order', () => {
  it('ADR-0019 batches that name the pair in opposite order at once do not deadlock', async () => {
    const turned = [accountElement(), element()];
    const answers = await Promise.all([
      batch(service('api-gateway'), pair2()),
      batch(service('api-gateway'), turned),
      batch(service('api-gateway'), pair2()),
      batch(service('api-gateway'), turned),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    // The answer follows the order of the request, whatever order the work was done in.
    expect(itemsOf(answers[0] as { body: unknown })[0]?.pseudonym).toBe(
      itemsOf(answers[1] as { body: unknown })[1]?.pseudonym,
    );
    expect(await count('pseudonym_mapping')).toBe(2);
    expect(await count('audit_log')).toBe(8);
  });
});

describe('ADR-0019 the batch is refused whole (all or nothing)', () => {
  it('ADR-0019 a second element the policy refuses leaves no mapping and exactly one DENIED row', async () => {
    const refused = accountElement({ purpose: 'FRAUD_DETECTION' });
    const answer = await batch(service('api-gateway'), [element(), refused]);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    // The same answer as the refused element alone gets on the single route.
    const single = await post('/pseudonymize', service('api-gateway'), refused);
    expect(answer.status).toBe(single.status);
    const refusal = (body: unknown) => {
      const { code, reason } = (body as { error: { code: string; reason: string } }).error;
      return { code, reason };
    };
    expect(refusal(answer.body)).toEqual(refusal(single.body));
    expect(await count('pseudonym_mapping')).toBe(0);
    // One DENIED row for the batch and one for the single call just made; no SUCCESS row of the first element.
    expect((await auditRows()).map((row) => row.status)).toEqual(['DENIED', 'DENIED']);
  });

  it('ADR-0019 TK-19 a caller that is not the Gateway is refused the whole batch, as on the single route', async () => {
    const answer = await batch(service('transaction'), pair2());
    const single = await post('/pseudonymize', service('transaction'), element());
    expect(answer.status).toBe(single.status);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await count('pseudonym_mapping')).toBe(0);
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'DENIED')).toBe(true);
  });

  it('ADR-0019 a person token cannot call it', async () => {
    const answer = await batch(person('admin'), pair2());
    expect(answer.status).toBe(403);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  const unauthenticated: [string, () => string | undefined][] = [
    ['no bearer token', () => undefined],
    ['alg none', algNone],
    ['HS256 signed with the public key', hs256],
    [
      'a signature by a key nobody published',
      () => service('api-gateway', ['privacy-service'], stranger.privateKey),
    ],
  ];
  it.each(unauthenticated)('ADR-0019 TK-19 %s is 401 and writes nothing', async (_name, token) => {
    const answer = await batch(token(), pair2());
    expect(answer.status).toBe(401);
    expect(await count('audit_log')).toBe(0);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  it('ADR-0019 the IdP being down is 503 and nothing is written (fail closed, invariant 8)', async () => {
    jwksFailing = true;
    const answer = await batch(service('api-gateway'), pair2());
    expect(answer.status).toBe(503);
    expect(await count('pseudonym_mapping')).toBe(0);
  });
});

describe('ADR-0019 the shape of a batch', () => {
  const exchange = {
    source_pseudonym: 'PSEU-00000001',
    target_service: 'FRAUD',
    purpose: 'FRAUD_DETECTION',
    transaction_id: 'TX-7001',
  };
  const shapes: [string, unknown][] = [
    ['an empty list', []],
    ['three elements', [element(), accountElement(), element()]],
    ['an element with a field nobody knows', [element({ requesting_service: 'API_GATEWAY' })]],
    ['an exchange element', [exchange]],
    ['a subject id of the wrong format', [element({ subject_id: 'not-a-customer' })]],
    ['a list that is not a list', CUSTOMER],
    ['two elements of the same subject type', [element(), element({ subject_id: 'CUST-000102' })]],
  ];
  it.each(shapes)('ADR-0019 %s is 422 and writes nothing', async (_name, requests) => {
    const answer = await batch(service('api-gateway'), requests);
    expect(answer.status).toBe(422);
    expect(await count('audit_log')).toBe(0);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  it('ADR-0019 a field next to requests is a field nobody knows (D-16)', async () => {
    const answer = await post('/pseudonymize/batch', service('api-gateway'), {
      requests: pair2(),
      requesting_service: 'API_GATEWAY',
    });
    expect(answer.status).toBe(422);
    expect(await count('audit_log')).toBe(0);
  });

  it('ADR-0019 a body padded past the limit of every endpoint is 422 (K-12)', async () => {
    const padded = `${JSON.stringify({ requests: pair2() })}${' '.repeat(17 * 1024)}`;
    const answer = await server()
      .post('/pseudonymize/batch')
      .set('authorization', `Bearer ${service('api-gateway')}`)
      .set('content-type', 'application/json')
      .send(padded);
    expect(answer.status).toBe(422);
    expect(await count('audit_log')).toBe(0);
  });

  it('ADR-0019 no log line carries a subject id', async () => {
    await batch(service('api-gateway'), pair2());
    const logs = logLines.join('\n');
    expect(logs).not.toContain(CUSTOMER);
    expect(logs).not.toContain(ACCOUNT);
  });
});
