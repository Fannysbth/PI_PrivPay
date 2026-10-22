import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import {
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  ROLE_SERVICES,
  signJwt,
  type HumanRole,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { reconciliationModules } from '../src/reconciliation.module';
import { FakePrivacy, FakeTransactions } from './fakes';

// Seam: POST /reconciliation/audit-request and POST /reconciliation/disclosure over HTTP (AZ-36, AZ-37, AZ-06, AZ-07), with the
// service's real module on the real database and the IdP's keys served by a stub. The neighbours are doubles. The report
// arrives tokenised: whatever else arrives is refused, and nothing it carries is an account number. Every value is
// invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'reconciliation-http-test';
const ISSUER = 'privpay-dev-idp';

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;
let transactions: FakeTransactions;
let privacy: FakePrivacy;
let logLines: string[];

const claims = (sub: string, azp: string, aud: string[], extra: object = {}) => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub, azp, aud, ...extra };
};
const service = (client: string, aud = ['reconciliation-service']): string =>
  signJwt(claims(client, client, aud), { privateKey: pair.privateKey, kid: KID });
const bank = (): string =>
  signJwt(
    claims('usr-bank-01', 'bank-simulator', ['reconciliation-service'], { roles: ['bank'] }),
    {
      privateKey: pair.privateKey,
      kid: KID,
    },
  );
const person = (role: HumanRole): string =>
  signJwt(claims(`usr-${role}`, 'admin-console', [...ROLE_SERVICES[role]], { roles: [role] }), {
    privateKey: pair.privateKey,
    kid: KID,
  });

beforeEach(async () => {
  clock = new FakeClock('2026-10-06T00:10:00.000Z');
  logLines = [];
  db = await createTestDb(pg, { service: 'reconciliation', suffix: 'm407h' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  transactions = new FakeTransactions();
  privacy = new FakePrivacy();
  transactions.details.set('TX-10001', {
    transactionId: 'TX-10001',
    amount: 35_000,
    status: 'COMPLETED',
  });
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
      service: 'reconciliation-service',
      modules: reconciliationModules({
        fetch: fetchStub,
        pools: { app: db.app },
        transactions,
        privacy,
        logDestination: { write: (line) => void logLines.push(line) },
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
      RECON_DAILY_RUN_UTC: '00:10',
      PRIVACY_SERVICE_URL: 'http://privacy.test',
      TRANSACTION_SERVICE_URL: 'http://transaction.test',
    },
    { clock },
  );
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const post = (path: string, body: unknown, token?: string, actor?: string) => {
  const call = request(app.httpServer).post(path);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  if (actor !== undefined) void call.set('x-actor-token', actor);
  return call.send(body as object);
};
const TX = 'TX-10001';
const P7 = 'PSEU-6C3F8A21';
const DISCLOSURE = '5f2b9b0e-2d57-4b1e-8c3a-0b7f6a1d4c11';
const audit = (body: unknown, token?: string, actor?: string) =>
  post('/reconciliation/audit-request', body, token, actor);
const disclose = (body: unknown, token?: string, actor?: string) =>
  post('/reconciliation/disclosure', body, token, actor);
const gateway = () => service('api-gateway');
const auditBody = { transaction_id: TX, reason_code: 'DISPUTE' };
const discloseBody = { audit_token: P7, disclosure_id: DISCLOSURE };
const rows = async (table: string) =>
  (await db.owner.query(`SELECT * FROM ${table}`)).rows as Record<string, unknown>[];
// Invented values of the three attributes: none of them may be found anywhere but in the answer to the auditor.
const OPENED = { customer_id: 'CUST-900052', nik: '9999500000000052', nama: 'Kenari Abcdef' };

describe('M4-07 FR-22 TK-22 POST /reconciliation/audit-request', () => {
  it('M4-07 FR-22 the auditor gets a P7 token and the data of the transaction, and nothing that names the customer', async () => {
    const actor = person('auditor');
    const answer = await audit(auditBody, gateway(), actor);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      transaction_id: TX,
      audit_token: P7,
      amount: 35_000,
      status: 'COMPLETED',
    });
    expect(JSON.stringify(answer.body)).not.toMatch(/customer|nik|nama|CUST-|rekening|account/i);
    // The actor token goes to Privacy as it came: Privacy checks the role again (P7 needs an auditor).
    expect(privacy.auditCalls).toEqual([
      { transactionId: TX, actor: { actorId: 'usr-auditor', token: actor } },
    ]);
  });

  it('M4-07 FR-22 exactly one row of audit_requests per request, with the coded reason and the actor of the token', async () => {
    const answer = await audit(auditBody, gateway(), person('auditor'));
    expect(await rows('audit_requests')).toEqual([
      {
        request_id: (answer.body as { request_id: string }).request_id,
        transaction_id: TX,
        reason_code: 'DISPUTE',
        actor_id: 'usr-auditor',
        requested_at: clock.now(),
      },
    ]);
    await audit({ ...auditBody, reason_code: 'OTHER' }, gateway(), person('auditor'));
    expect(await rows('audit_requests')).toHaveLength(2);
  });

  it('M4-07 FR-22 twenty requests at once leave twenty rows and twenty answers, none lost', async () => {
    const actor = person('auditor');
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => audit(auditBody, gateway(), actor)),
    );
    expect(answers.map((a) => a.status)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(new Set(answers.map((a) => (a.body as { request_id: string }).request_id)).size).toBe(
      20,
    );
    expect(await rows('audit_requests')).toHaveLength(20);
  });

  it('M4-07 K-02 a transaction that is not there is TRANSACTION_NOT_FOUND, Privacy is not asked and no row is made', async () => {
    const answer = await audit(
      { ...auditBody, transaction_id: 'TX-99999' },
      gateway(),
      person('auditor'),
    );
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ error: { reason: 'TRANSACTION_NOT_FOUND' } });
    expect(privacy.auditCalls).toEqual([]);
    expect(await rows('audit_requests')).toEqual([]);
  });

  it.each([
    ['TOKEN_NOT_FOUND', 404],
    ['FORBIDDEN_ROLE', 403],
    ['REVOKED', 403],
  ] as const)(
    'M4-07 FR-22 Privacy refusing with %s is passed on as it is and no row is made',
    async (reason, status) => {
      privacy.auditRefusal = reason;
      const answer = await audit(auditBody, gateway(), person('auditor'));
      expect(answer.status).toBe(status);
      expect(answer.body).toMatchObject({ error: { reason } });
      expect(await rows('audit_requests')).toEqual([]);
    },
  );

  it('M4-07 K-22 Privacy or Transaction that cannot answer is 503 and no row is made', async () => {
    privacy.fail = true;
    expect((await audit(auditBody, gateway(), person('auditor'))).status).toBe(503);
    privacy.fail = false;
    transactions.fail = true;
    expect((await audit(auditBody, gateway(), person('auditor'))).status).toBe(503);
    expect(await rows('audit_requests')).toEqual([]);
  });

  it.each([
    ['a customer id in the body', { ...auditBody, customer_id: 'CUST-000101' }],
    ['an actor in the body', { ...auditBody, actor_id: 'usr-someone' }],
    ['a free-text reason', { ...auditBody, reason_code: 'The customer called me' }],
    ['a reason outside the three', { ...auditBody, reason_code: 'CURIOSITY' }],
    ['no reason', { transaction_id: TX }],
    ['a transaction id of another shape', { ...auditBody, transaction_id: '10001' }],
    ['a transaction id with SQL in it', { ...auditBody, transaction_id: "TX-1'; DROP TABLE x;--" }],
    ['a body that is not an object', 'TX-10001'],
  ])(
    'M4-07 TK-22 %s is VALIDATION_ERROR: nobody is asked and no row is made',
    async (_label, body) => {
      const answer = await audit(body, gateway(), person('auditor'));
      expect(answer.status).toBe(422);
      expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(transactions.asked).toEqual([]);
      expect(privacy.auditCalls).toEqual([]);
      expect(await rows('audit_requests')).toEqual([]);
    },
  );
});

describe('M4-07 AZ-36 AZ-06 who may ask for an audit', () => {
  it.each([['admin'], ['fraud_analyst']] as const)(
    'M4-07 AZ-36 the Gateway for a %s is FORBIDDEN_ROLE and nobody is asked',
    async (role) => {
      const answer = await audit(auditBody, gateway(), person(role));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
      expect(transactions.asked).toEqual([]);
      expect(await rows('audit_requests')).toEqual([]);
    },
  );

  it('M4-07 AZ-36 the Gateway without a person is FORBIDDEN_ROLE', async () => {
    const answer = await audit(auditBody, gateway());
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
  });

  it('M4-07 AZ-36 N1 an auditor token alone is 401, and no credential is 401', async () => {
    expect((await audit(auditBody, undefined, person('auditor'))).status).toBe(401);
    expect((await audit(auditBody)).status).toBe(401);
  });

  it.each([['transaction'], ['fraud'], ['notification'], ['reconciliation']])(
    'M4-07 AZ-36 N2 the service %s with an auditor is POLICY_NOT_ALLOWED',
    async (client) => {
      const answer = await audit(auditBody, service(client), person('auditor'));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(transactions.asked).toEqual([]);
    },
  );
});

describe('M4-07 FR-09 FR-43 T-14 POST /reconciliation/disclosure', () => {
  beforeEach(() => {
    privacy.openAnswer = OPENED;
  });

  it('M4-07 FR-43 the auditor gets the attributes Privacy released, and only them', async () => {
    const actor = person('auditor');
    const answer = await disclose(discloseBody, gateway(), actor);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ attributes: OPENED });
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(privacy.openCalls).toEqual([
      { auditToken: P7, disclosureId: DISCLOSURE, actor: { actorId: 'usr-auditor', token: actor } },
    ]);
  });

  it('M4-07 FR-43 only the attributes Privacy named come back: one approved attribute is one attribute', async () => {
    privacy.openAnswer = { nama: OPENED.nama };
    const answer = await disclose(discloseBody, gateway(), person('auditor'));
    expect(answer.body).toEqual({ attributes: { nama: OPENED.nama } });
  });

  it.each([
    ['DISCLOSURE_NOT_FOUND', 404],
    ['DISCLOSURE_NOT_APPROVED', 403],
    ['DISCLOSURE_EXPIRED', 410],
    ['REQUESTER_MISMATCH', 403],
    ['PURPOSE_MISMATCH', 403],
    ['FORBIDDEN_ROLE', 403],
  ] as const)(
    'M4-07 TK-21 Privacy refusing with %s is passed on and nothing is opened',
    async (reason, status) => {
      privacy.openAnswer = reason;
      const answer = await disclose(discloseBody, gateway(), person('auditor'));
      expect(answer.status).toBe(status);
      expect(answer.body).toMatchObject({ error: { reason } });
      expect(JSON.stringify(answer.body)).not.toContain(OPENED.nama);
    },
  );

  it('M4-07 K-22 Privacy that cannot answer is 503, asked once and never again (a second call would be a second use)', async () => {
    privacy.fail = true;
    const answer = await disclose(discloseBody, gateway(), person('auditor'));
    expect(answer.status).toBe(503);
    expect(privacy.openCalls).toHaveLength(1);
  });

  it.each([
    [
      'a field outside the three tables of Tabel 5',
      { customer_id: 'CUST-900052', hp: '081200000052' },
    ],
    ['an attribute that is not text', { nik: 9_999_500_000_000_052 }],
    ['an empty text', { nama: '' }],
    ['an attribute not named in the contract', { rekening: '9999000052' }],
  ])(
    'M4-07 T-14 an answer with %s is not passed on: 503, fail closed',
    async (_label, attributes) => {
      privacy.openAnswer = attributes as never;
      const answer = await disclose(discloseBody, gateway(), person('auditor'));
      expect(answer.status).toBe(503);
      expect(JSON.stringify(answer.body)).not.toMatch(/CUST-|9999|0812/);
    },
  );

  it('M4-07 T-14 what was opened is in no table, no log line and no metric of Reconciliation', async () => {
    await audit(auditBody, gateway(), person('auditor'));
    const answer = await disclose(discloseBody, gateway(), person('auditor'));
    expect(JSON.stringify(answer.body)).toContain(OPENED.nama);
    const metrics = await request(app.httpServer).get('/metrics');
    const dump = JSON.stringify([
      await rows('settlement_batches'),
      await rows('settlement_items'),
      await rows('audit_requests'),
      logLines,
      metrics.text,
    ]);
    for (const value of Object.values(OPENED)) expect(dump).not.toContain(value);
  });

  it('M4-07 FR-43 a disclosure writes no row of its own: the record of an audit is the request and Privacy', async () => {
    await disclose(discloseBody, gateway(), person('auditor'));
    expect(await rows('audit_requests')).toEqual([]);
    expect(await rows('settlement_batches')).toEqual([]);
  });

  it.each([
    ['the attributes to open named by the caller', { ...discloseBody, attributes: ['nik'] }],
    ['a purpose of the caller', { ...discloseBody, purpose: 'DAILY_RECONCILIATION' }],
    ['a requester in the body', { ...discloseBody, requester_id: 'usr-x' }],
    ['an audit token that is not a token', { ...discloseBody, audit_token: 'CUST-000101' }],
    ['an audit token that is an account number', { ...discloseBody, audit_token: '1234567801' }],
    ['a disclosure id that is not a UUID', { ...discloseBody, disclosure_id: 'approved' }],
    ['no disclosure id', { audit_token: P7 }],
    ['no audit token', { disclosure_id: DISCLOSURE }],
  ])('M4-07 FR-09 %s is VALIDATION_ERROR and Privacy is not asked', async (_label, body) => {
    const answer = await disclose(body, gateway(), person('auditor'));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(privacy.openCalls).toEqual([]);
  });
});

describe('M4-07 AZ-37 AZ-07 who may open', () => {
  beforeEach(() => {
    privacy.openAnswer = OPENED;
  });

  it.each([['admin'], ['fraud_analyst']] as const)(
    'M4-07 AZ-37 the Gateway for a %s is FORBIDDEN_ROLE and Privacy is not asked',
    async (role) => {
      const answer = await disclose(discloseBody, gateway(), person(role));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
      expect(privacy.openCalls).toEqual([]);
    },
  );

  it('M4-07 AZ-37 the Gateway without a person is FORBIDDEN_ROLE', async () => {
    expect((await disclose(discloseBody, gateway())).status).toBe(403);
    expect(privacy.openCalls).toEqual([]);
  });

  it('M4-07 AZ-37 N1 an auditor token alone is 401, and no credential is 401', async () => {
    expect((await disclose(discloseBody, undefined, person('auditor'))).status).toBe(401);
    expect((await disclose(discloseBody)).status).toBe(401);
  });

  it.each([['transaction'], ['fraud'], ['notification'], ['reconciliation']])(
    'M4-07 AZ-37 N2 the service %s with an auditor is POLICY_NOT_ALLOWED',
    async (client) => {
      const answer = await disclose(discloseBody, service(client), person('auditor'));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(privacy.openCalls).toEqual([]);
    },
  );

  it('M4-07 AZ-37 N3 the bank is refused: without a person POLICY_NOT_ALLOWED, with one FORBIDDEN_ROLE (only the Gateway carries a person)', async () => {
    const alone = await disclose(discloseBody, bank());
    expect(alone.status).toBe(403);
    expect(alone.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    const withPerson = await disclose(discloseBody, bank(), person('auditor'));
    expect(withPerson.status).toBe(403);
    expect(withPerson.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    expect(privacy.openCalls).toEqual([]);
  });
});
