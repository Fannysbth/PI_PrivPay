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
      DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
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

  it('M2-12 TK-19 an expired token is 401 and writes nothing', async () => {
    const token = service('api-gateway');
    clock.advance(301);
    const answer = await post('/pseudonymize', token, body);
    expect(answer.status).toBe(401);
    expect(await count('pseudonym_mapping')).toBe(0);
  });

  it('M2-12 ADR-0007 a person at Authorization takes no X-Actor-Token', async () => {
    const answer = await post('/pseudonymize', person('admin'), body, person('auditor'));
    expect(answer.status).toBe(403);
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

  it('M2-12 K-12 a valid body padded with white space past 16 KiB is 422, not 200', async () => {
    const answer = await server()
      .post('/pseudonymize')
      .set('authorization', `Bearer ${service('api-gateway')}`)
      .set('content-type', 'application/json')
      .send(JSON.stringify(identityBody()) + ' '.repeat(17_000));
    expect(answer.status).toBe(422);
    expect(await count('pseudonym_mapping')).toBe(0);
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

describe('M3-01 POST /resolve-domain', () => {
  const p4Of = async (): Promise<string> => {
    const answer = await post('/pseudonymize', service('transaction'), {
      source_pseudonym: await issueP1(),
      target_service: 'NOTIFICATION',
      purpose: 'NOTIFICATION',
      transaction_id: 'TX-7001',
    });
    return (answer.body as { pseudonym: string }).pseudonym;
  };
  const p5 = async (): Promise<string> =>
    (
      (
        await post('/pseudonymize', service('api-gateway'), {
          subject_type: 'CUSTOMER',
          subject_id: CUSTOMER,
          target_service: 'NOTIFICATION',
          purpose: 'NOTIFICATION_REGISTRATION',
        })
      ).body as { pseudonym: string }
    ).pseudonym;

  it('M3-01 AZ-21 N1 no credential is 401 and writes no audit row', async () => {
    const answer = await post('/resolve-domain', undefined, { notif_token: 'PSEU-00000000' });
    expect(answer.status).toBe(401);
    expect(await count('audit_log')).toBe(0);
  });

  it('M3-01 AZ-21 N2 TRANSACTION is POLICY_NOT_ALLOWED with one DENIED row; NOTIFICATION gets only the PSEU token', async () => {
    const domain = await p5();
    const p4 = await p4Of();
    const before = await count('audit_log');
    const denied = await post('/resolve-domain', service('transaction'), { notif_token: p4 });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    expect(await count('audit_log')).toBe(before + 1);
    expect(await lastAudit()).toMatchObject({
      action: 'RESOLVE_NOTIF_DOMAIN',
      status: 'DENIED',
      requesting_service: 'TRANSACTION',
    });

    const ok = await post('/resolve-domain', service('notification'), { notif_token: p4 });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ notification_domain_id: domain });
    expect(JSON.stringify(ok.body)).not.toContain(CUSTOMER);
  });

  it('M3-01 AZ-21 N2 a person is refused too: only the service NOTIFICATION resolves', async () => {
    const p4 = await p4Of();
    const answer = await post('/resolve-domain', person('admin'), { notif_token: p4 });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
  });

  it('M3-01 AZ-21 N3 an unknown field is 422 and is not audited', async () => {
    const p4 = await p4Of();
    const before = await count('audit_log');
    const answer = await post('/resolve-domain', service('notification'), {
      notif_token: p4,
      subject_id: CUSTOMER,
    });
    expect(answer.status).toBe(422);
    expect(await count('audit_log')).toBe(before);
  });

  it('M3-01 AZ-21 N4 requesting_service in the body is a field nobody knows (D-16)', async () => {
    const p4 = await p4Of();
    const answer = await post('/resolve-domain', service('transaction'), {
      notif_token: p4,
      requesting_service: 'NOTIFICATION',
    });
    expect(answer.status).toBe(422);
  });

  it('M3-01 FR-08 a token that does not exist is 404 TOKEN_NOT_FOUND', async () => {
    const answer = await post('/resolve-domain', service('notification'), {
      notif_token: 'PSEU-00000000',
    });
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ error: { reason: 'TOKEN_NOT_FOUND' } });
  });
});

describe('M3-02 POST /pseudonym/{pseudonym}/revoke and POST /subject/revoke', () => {
  const revokePath = (pseudonym: string) => `/pseudonym/${pseudonym}/revoke`;

  it('M3-02 AZ-16 N1 no credential is 401 and changes nothing', async () => {
    const p1 = await issueP1();
    expect((await post(revokePath(p1), undefined, {})).status).toBe(401);
    expect(await count('audit_log')).toBe(1);
  });

  it('M3-02 AZ-16 N2 an auditor and a service are refused with one DENIED row each; the admin revokes, then repeats', async () => {
    const p1 = await issueP1();
    const before = await count('audit_log');
    const auditor = await post(revokePath(p1), person('auditor'), {});
    expect(auditor.status).toBe(403);
    expect(auditor.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    const service403 = await post(revokePath(p1), service('transaction'), {});
    expect(service403.status).toBe(403);
    expect(service403.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    expect(await count('audit_log')).toBe(before + 2);

    const first = await post(revokePath(p1), person('admin'), {});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      pseudonym: p1,
      status: 'revoked',
      revoked_at: '2026-10-20T08:00:00.000Z',
    });
    clock.advance(5);
    const again = await post(revokePath(p1), person('admin'), undefined);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await lastAudit()).toMatchObject({
      action: 'REVOKE_TOKEN',
      status: 'SUCCESS',
      actor_id: 'usr-admin',
      requesting_service: 'ADMIN_CONSOLE',
    });
  });

  it('M3-02 AZ-16 N2 a token that is not there is 404 with one DENIED row', async () => {
    const answer = await post(revokePath('PSEU-00000000'), person('admin'), {});
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ error: { reason: 'TOKEN_NOT_FOUND' } });
    expect(await lastAudit()).toMatchObject({ action: 'REVOKE_TOKEN', status: 'DENIED' });
  });

  it('M3-02 AZ-16 N3 N4 a field in the body is 422 and nothing changes, whoever it claims to be', async () => {
    const p1 = await issueP1();
    const before = await count('audit_log');
    const extra = await post(revokePath(p1), person('admin'), { reason: 'x' });
    const claim = await post(revokePath(p1), service('transaction'), {
      requesting_service: 'ADMIN_CONSOLE',
    });
    expect([extra.status, claim.status]).toEqual([422, 422]);
    expect(await count('audit_log')).toBe(before);
    const malformed = await post(revokePath('not-a-token'), person('admin'), {});
    expect(malformed.status).toBe(422);
  });

  it('M3-02 AZ-17 N1 no credential is 401', async () => {
    expect(
      (await post('/subject/revoke', undefined, { subject_type: 'CUSTOMER', subject_id: CUSTOMER }))
        .status,
    ).toBe(401);
  });

  it('M3-02 AZ-17 TK-17 N2 the admin revokes the subject and gets the count; an auditor does not', async () => {
    await issueP1();
    const body = { subject_type: 'CUSTOMER', subject_id: CUSTOMER };
    const denied = await post('/subject/revoke', person('auditor'), body);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    const ok = await post('/subject/revoke', person('admin'), body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ revoked_count: 1 });
    const none = await post('/subject/revoke', person('admin'), body);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ revoked_count: 0 });
    expect(await lastAudit()).toMatchObject({ action: 'REVOKE_SUBJECT', status: 'DENIED' });
    expect(JSON.stringify(await lastAudit())).not.toContain(CUSTOMER);
    expect(logLines.join(' ')).not.toContain(CUSTOMER);
  });

  it('M3-02 AZ-17 N3 N4 an unknown field is 422 and nothing changes', async () => {
    await issueP1();
    const before = await count('audit_log');
    const answer = await post('/subject/revoke', person('admin'), {
      subject_type: 'CUSTOMER',
      subject_id: CUSTOMER,
      requesting_service: 'ADMIN_CONSOLE',
    });
    expect(answer.status).toBe(422);
    expect(await count('audit_log')).toBe(before);
    expect(
      (await post('/subject/revoke', person('admin'), { subject_type: 'CUSTOMER' })).status,
    ).toBe(422);
  });
});

describe('M3-04 POST /disclosure-requests and its approve and reject', () => {
  const p7 = async (): Promise<string> => {
    await issueP1();
    const answer = await post(
      '/pseudonymize',
      service('reconciliation'),
      {
        subject_type: 'CUSTOMER',
        transaction_id: 'TX-7001',
        target_service: 'RECONCILIATION',
        purpose: 'INTERNAL_AUDIT',
      },
      person('auditor'),
    );
    return (answer.body as { pseudonym: string }).pseudonym;
  };
  const requestBody = (token: string, over: Record<string, unknown> = {}) => ({
    audit_token: token,
    basis: 'DISPUTE',
    case_ref: 'KASUS-2026-014',
    attributes: ['nama'],
    ...over,
  });
  const open = async (): Promise<string> =>
    (
      (await post('/disclosure-requests', person('auditor'), requestBody(await p7()))).body as {
        disclosure_id: string;
      }
    ).disclosure_id;

  it('M3-04 AZ-10 N1 no credential is 401 and writes nothing', async () => {
    const before = await count('audit_log');
    expect(
      (await post('/disclosure-requests', undefined, requestBody('PSEU-00000001'))).status,
    ).toBe(401);
    expect(await count('audit_log')).toBe(before);
    expect(await count('disclosure_request')).toBe(0);
  });

  it('M3-04 AZ-10 N2 the auditor gets 201 PENDING; an admin is FORBIDDEN_ROLE, a service POLICY_NOT_ALLOWED, one DENIED row each', async () => {
    const token = await p7();
    const before = await count('audit_log');
    const admin = await post('/disclosure-requests', person('admin'), requestBody(token));
    expect(admin.status).toBe(403);
    expect(admin.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    const svc = await post('/disclosure-requests', service('reconciliation'), requestBody(token));
    expect(svc.status).toBe(403);
    expect(svc.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    expect(await count('audit_log')).toBe(before + 2);
    expect(await count('disclosure_request')).toBe(0);

    const ok = await post('/disclosure-requests', person('auditor'), requestBody(token));
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ disclosure_id: expect.any(String) as unknown, status: 'PENDING' });
  });

  it('M3-04 AZ-10 TK-27 a basis or an attribute outside the tables is 422, with no request row and one DENIED row', async () => {
    const token = await p7();
    const before = await count('audit_log');
    const basis = await post(
      '/disclosure-requests',
      person('auditor'),
      requestBody(token, { basis: 'CURIOSITY' }),
    );
    const attribute = await post(
      '/disclosure-requests',
      person('auditor'),
      requestBody(token, { attributes: ['hp'] }),
    );
    expect([basis.status, attribute.status]).toEqual([422, 422]);
    expect(basis.body).toMatchObject({ error: { reason: 'INVALID_BASIS' } });
    expect(attribute.body).toMatchObject({ error: { reason: 'ATTRIBUTE_NOT_ALLOWED' } });
    expect(await count('disclosure_request')).toBe(0);
    expect(await count('audit_log')).toBe(before + 2);
  });

  it('M3-04 AZ-10 N3 N4 an unknown field or a claimed requesting_service is 422 and nothing is written', async () => {
    const token = await p7();
    const before = await count('audit_log');
    const extra = await post(
      '/disclosure-requests',
      person('auditor'),
      requestBody(token, { extra: 1 }),
    );
    const claim = await post(
      '/disclosure-requests',
      person('auditor'),
      requestBody(token, { requesting_service: 'ADMIN_CONSOLE' }),
    );
    const requester = await post(
      '/disclosure-requests',
      person('auditor'),
      requestBody(token, { requester_id: 'usr-admin' }),
    );
    expect([extra.status, claim.status, requester.status]).toEqual([422, 422, 422]);
    expect(await count('audit_log')).toBe(before);
    expect(await count('disclosure_request')).toBe(0);
  });

  it('M3-04 AZ-11 TK-24 TK-25 the admin approves for 600 s; an auditor is FORBIDDEN_ROLE; the requester cannot approve their own', async () => {
    const id = await open();
    const path = `/disclosure-requests/${id}/approve`;
    expect((await post(path, undefined, {})).status).toBe(401);
    const auditor = await post(path, person('auditor'), {});
    expect(auditor.status).toBe(403);
    expect(auditor.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    const ok = await post(path, person('admin'), {});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      disclosure_id: id,
      status: 'APPROVED',
      expires_at: '2026-10-20T08:10:00.000Z',
    });
    const again = await post(path, person('admin'), undefined);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { reason: 'DISCLOSURE_NOT_PENDING' } });
  });

  it('M3-04 AZ-12 the admin rejects; a fraud analyst never reaches Privacy; an unknown id is 404; a field in the body is 422', async () => {
    const id = await open();
    const path = `/disclosure-requests/${id}/reject`;
    expect((await post(path, person('fraud_analyst'), {})).status).toBe(403);
    expect((await post(path, person('admin'), { reason: 'x' })).status).toBe(422);
    const ok = await post(path, person('admin'), {});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ disclosure_id: id, status: 'REJECTED' });
    const missing = await post(
      '/disclosure-requests/00000000-0000-4000-8000-000000000000/reject',
      person('admin'),
      {},
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { reason: 'DISCLOSURE_NOT_FOUND' } });
    expect((await post('/disclosure-requests/not-a-uuid/reject', person('admin'), {})).status).toBe(
      422,
    );
  });

  it('M3-04 FR-15 the audit rows and the log of the whole flow carry attribute names only, never a value or the case reference', async () => {
    const id = await open();
    await post(`/disclosure-requests/${id}/approve`, person('admin'), {});
    const rows = JSON.stringify(
      (await db.owner.query('SELECT * FROM audit_log WHERE action LIKE $1', ['DISCLOSURE_%'])).rows,
    );
    expect(rows).toContain('"nama"');
    for (const value of [CUSTOMER, 'KASUS-2026-014']) {
      expect(rows).not.toContain(value);
      expect(logLines.join(' ')).not.toContain(value);
    }
  });
});

describe('M3-05 POST /de-pseudonymize', () => {
  const IDENTITY = {
    customer_id: CUSTOMER,
    nik: '9999000011112222',
    nama: 'Budi Contoh Palsu',
    hp: '081200000001',
    rekening: '99990000000001',
  };
  const asReconciliation = (body: unknown, actor = person('auditor')) =>
    post('/de-pseudonymize', service('reconciliation'), body, actor);
  /** A stored identity, its P7, and an approved request for `nama`; the body of the call that opens it. */
  const approved = async (): Promise<{ pseudonym: string; disclosure_id: string }> => {
    expect((await post('/identity', service('api-gateway'), IDENTITY)).status).toBe(201);
    await issueP1();
    const p7 = (
      (
        await post(
          '/pseudonymize',
          service('reconciliation'),
          {
            subject_type: 'CUSTOMER',
            transaction_id: 'TX-7001',
            target_service: 'RECONCILIATION',
            purpose: 'INTERNAL_AUDIT',
          },
          person('auditor'),
        )
      ).body as { pseudonym: string }
    ).pseudonym;
    const requested = await post('/disclosure-requests', person('auditor'), {
      audit_token: p7,
      basis: 'DISPUTE',
      case_ref: 'KASUS-2026-014',
      attributes: ['nama'],
    });
    const id = (requested.body as { disclosure_id: string }).disclosure_id;
    expect((await post(`/disclosure-requests/${id}/approve`, person('admin'), {})).status).toBe(
      200,
    );
    return { pseudonym: p7, disclosure_id: id };
  };
  const bodyOf = (given: { pseudonym: string; disclosure_id: string }) => ({
    ...given,
    purpose: 'INTERNAL_AUDIT',
  });

  it('M3-05 AZ-22 N1 no credential is 401 and writes no audit row', async () => {
    const given = await approved();
    const before = await count('audit_log');
    expect((await post('/de-pseudonymize', undefined, bodyOf(given))).status).toBe(401);
    expect(await count('audit_log')).toBe(before);
  });

  it('M3-05 AZ-22 N2 a service other than RECONCILIATION is POLICY_NOT_ALLOWED, an admin FORBIDDEN_ROLE, one DENIED row each', async () => {
    const given = await approved();
    const before = await count('audit_log');
    const other = await post('/de-pseudonymize', service('api-gateway'), bodyOf(given));
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    const admin = await asReconciliation(bodyOf(given), person('admin'));
    expect(admin.status).toBe(403);
    expect(admin.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    expect(await count('audit_log')).toBe(before + 2);
    expect(await lastAudit()).toMatchObject({ action: 'DE_PSEUDONYMIZE', status: 'DENIED' });
    expect((await db.owner.query(`SELECT status FROM disclosure_request`)).rows[0]).toMatchObject({
      status: 'APPROVED',
    });
  });

  it('M3-05 AZ-22 N3 N4 an unknown field, a claimed requesting_service or a missing disclosure_id is 422 and not audited', async () => {
    const given = await approved();
    const before = await count('audit_log');
    const without = { pseudonym: given.pseudonym, purpose: 'INTERNAL_AUDIT' };
    const results = [
      await asReconciliation({ ...bodyOf(given), extra: 1 }),
      await asReconciliation({ ...bodyOf(given), requesting_service: 'ADMIN_CONSOLE' }),
      await asReconciliation(without),
    ];
    expect(results.map((result) => result.status)).toEqual([422, 422, 422]);
    expect(await count('audit_log')).toBe(before);
  });

  it('M3-05 NFR-10 the answer that carries an identity is never cached (Cache-Control: no-store)', async () => {
    const given = await approved();
    const opened = await asReconciliation(bodyOf(given));
    expect(opened.status).toBe(200);
    expect(opened.headers['cache-control']).toBe('no-store');
    // The refusal is not cached either: a proxy must not keep the answer of a first use for the second.
    const again = await asReconciliation(bodyOf(given));
    expect(again.status).toBe(403);
    expect(again.headers['cache-control']).toBe('no-store');
  });

  it('M3-05 AZ-22 TK-21 the auditor gets 200 with only the approved attribute and no subject; the log and the audit rows hold no value; a second use is 403', async () => {
    const given = await approved();
    const first = await asReconciliation(bodyOf(given));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      mapping_id: expect.any(String) as unknown,
      attributes: { nama: IDENTITY.nama },
    });
    const again = await asReconciliation(bodyOf(given));
    expect(again.status).toBe(403);
    expect(again.body).toMatchObject({ error: { reason: 'DISCLOSURE_NOT_APPROVED' } });
    expect(JSON.stringify(again.body)).not.toContain(IDENTITY.nama);

    const rows = JSON.stringify((await db.owner.query('SELECT * FROM audit_log')).rows);
    for (const value of Object.values(IDENTITY)) {
      expect(rows).not.toContain(value);
      expect(logLines.join(' ')).not.toContain(value);
    }
  });
});

describe('M3-03 GET /audit-log, /audit-log/timeline/{pseudonym}, /audit-log/summary', () => {
  const get = (path: string, token: string | undefined) => {
    const call = server().get(path);
    if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
    return call;
  };

  it('M3-03 AZ-13 AZ-14 AZ-15 N1 no credential is 401 and writes no row', async () => {
    for (const path of ['/audit-log', '/audit-log/timeline/PSEU-00000001', '/audit-log/summary']) {
      expect((await get(path, undefined)).status).toBe(401);
    }
    expect(await count('audit_log')).toBe(0);
  });

  it('M3-03 AZ-13 N2 an auditor and an admin read; a service is refused with one DENIED row, a fraud analyst at authentication', async () => {
    const p1 = await issueP1();
    const ok = await get('/audit-log?action=GENERATE_TOKEN', person('auditor'));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      items: [
        {
          id: expect.any(String) as unknown,
          created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as unknown,
          action: 'GENERATE_TOKEN',
          status: 'SUCCESS',
          reason: 'OK',
          requesting_service: 'API_GATEWAY',
          pseudonym: p1,
          purpose: 'PAYMENT_PROCESSING',
          transaction_id: 'TX-7001',
          mapping_id: expect.any(String) as unknown,
        },
      ],
      next_cursor: null,
    });
    expect((await get('/audit-log', person('admin'))).status).toBe(200);
    const before = await count('audit_log');
    const analyst = await get('/audit-log', person('fraud_analyst'));
    expect(analyst.status).toBe(403);
    expect(analyst.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    const svc = await get('/audit-log', service('reconciliation'));
    expect(svc.status).toBe(403);
    expect(svc.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    // A fraud analyst has no business at Privacy at all: authenticate refuses before the service (not audited here).
    expect(await count('audit_log')).toBe(before + 1);
    expect(await lastAudit()).toMatchObject({ action: 'VIEW_AUDIT_LOG', status: 'DENIED' });
  });

  it('M3-03 AZ-13 N3 N4 an unknown query field, or a claimed requesting_service, is 422 and writes nothing', async () => {
    const before = await count('audit_log');
    for (const query of [
      '?extra=1',
      '?requesting_service=ADMIN_CONSOLE',
      '?limit=201',
      '?limit=0',
      '?status=a&status=b',
      '?cursor=%00',
    ]) {
      expect((await get(`/audit-log${query}`, person('auditor'))).status).toBe(422);
    }
    expect(await count('audit_log')).toBe(before);
  });

  it('M3-03 AZ-14 N2 the timeline is for an auditor: an admin is FORBIDDEN_ROLE, the auditor gets the history oldest first', async () => {
    const p1 = await issueP1();
    clock.advance(1);
    await post(`/pseudonym/${p1}/revoke`, person('admin'), {});
    const denied = await get(`/audit-log/timeline/${p1}`, person('admin'));
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    const ok = await get(`/audit-log/timeline/${p1}`, person('auditor'));
    expect(ok.status).toBe(200);
    expect((ok.body as { items: { action: string }[] }).items.map((row) => row.action)).toEqual([
      'GENERATE_TOKEN',
      'REVOKE_TOKEN',
    ]);
    expect((await get('/audit-log/timeline/not-a-token', person('auditor'))).status).toBe(422);
  });

  it('M3-03 AZ-15 N2 the summary is for an auditor and counts the refusals', async () => {
    await post('/pseudonymize', service('transaction'), identityBody());
    expect((await get('/audit-log/summary', person('admin'))).status).toBe(403);
    const ok = await get('/audit-log/summary', person('auditor'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      total: expect.any(Number) as unknown,
      denied: expect.arrayContaining([{ reason: 'POLICY_NOT_ALLOWED', count: 1 }]) as unknown,
      alerts: [],
    });
    expect((await get('/audit-log/summary?from=yesterday', person('auditor'))).status).toBe(422);
  });

  it('M3-03 the answers carry no identity value', async () => {
    await issueP1();
    const all = JSON.stringify((await get('/audit-log?limit=200', person('auditor'))).body);
    expect(all).not.toContain(CUSTOMER);
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

describe('M2-08 POST /identity', () => {
  const person = {
    customer_id: CUSTOMER,
    nik: '9999000011112222',
    nama: 'Budi Contoh Palsu',
    hp: '081200000001',
    rekening: '99990000000001',
  };

  it('M2-08 AZ-25 N1 no credential is 401 and stores nothing', async () => {
    expect((await post('/identity', undefined, person)).status).toBe(401);
    expect(await count('identity_vault')).toBe(0);
  });

  it('M2-08 AZ-25 N2 TRANSACTION is POLICY_NOT_ALLOWED with no vault row (TK-20); API_GATEWAY gets 201 then 200', async () => {
    const denied = await post('/identity', service('transaction'), person);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    expect(await count('identity_vault')).toBe(0);
    expect(await lastAudit()).toMatchObject({ action: 'STORE_IDENTITY', status: 'DENIED' });

    const created = await post('/identity', service('api-gateway'), person);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      customer_id: CUSTOMER,
      stored: ['nik', 'nama', 'hp', 'rekening'],
    });
    const again = await post('/identity', service('api-gateway'), person);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(created.body);
    expect(await count('identity_vault')).toBe(1);
  });

  it('M2-08 AZ-25 N3 an unknown field is 422 and stores nothing', async () => {
    const answer = await post('/identity', service('api-gateway'), { ...person, email: 'x@y.z' });
    expect(answer.status).toBe(422);
    expect(await count('identity_vault')).toBe(0);
  });

  it('M2-08 AZ-25 N4 requesting_service in the body is not accepted: 422, and the token decides', async () => {
    const answer = await post('/identity', service('transaction'), {
      ...person,
      requesting_service: 'API_GATEWAY',
    });
    expect(answer.status).toBe(422);
    expect(await count('identity_vault')).toBe(0);
  });

  it('M2-08 FR-15 no identity value reaches the log or the audit row', async () => {
    await post('/identity', service('api-gateway'), person);
    const everything = logLines.join(' ') + JSON.stringify(await lastAudit());
    for (const value of [person.nik, person.nama, person.hp, person.rekening, CUSTOMER]) {
      expect(everything).not.toContain(value);
    }
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
