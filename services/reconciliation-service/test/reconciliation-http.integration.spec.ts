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
import { A1, A3, FakePrivacy, FakeTransactions, PRD16_COMPLETED } from './fakes';

// Seam: POST /reconciliation/settlement-report and POST /reconciliation/run over HTTP (AZ-34, AZ-35, AZ-08), with the
// service's real module on the real database and the IdP's keys served by a stub. The neighbours are doubles. The report
// arrives tokenised: whatever else arrives is refused, and nothing it carries is an account number. Every value is
// invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'reconciliation-http-test';
const ISSUER = 'privpay-dev-idp';
const DATE = '2026-10-05';

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
  db = await createTestDb(pg, { service: 'reconciliation', suffix: 'm406h' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  transactions = new FakeTransactions();
  privacy = new FakePrivacy();
  transactions.completed = PRD16_COMPLETED;
  privacy.tokens = new Map([
    ['TX-10001', A1],
    ['TX-10003', A3],
  ]);
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
const report = (body: unknown, token?: string) =>
  post('/reconciliation/settlement-report', body, token);
const run = (body: unknown, token?: string, actor?: string) =>
  post('/reconciliation/run', body, token, actor);
const gateway = () => service('api-gateway');
const rows = async (table: string) =>
  (await db.owner.query(`SELECT * FROM ${table}`)).rows as Record<string, unknown>[];

const ITEMS = [
  { account_pseudonym: A1, amount: 35_000, bank_reference: 'BNK-20261005-0001' },
  { account_pseudonym: A3, amount: 1_500_000, bank_reference: 'BNK-20261005-0002' },
];
const VALID = { batch_date: DATE, items: ITEMS };

describe('M4-06 AZ-34 who may send the settlement report', () => {
  it('M4-06 AZ-34 the Gateway gets 202 for the first report and 200 for the same one again', async () => {
    const first = await report(VALID, gateway());
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ batch_date: DATE, item_count: 2 });
    const again = await report(VALID, gateway());
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ batch_date: DATE, item_count: 2 });
    expect(await rows('settlement_items')).toHaveLength(2);
  });

  it('M4-06 K-22 a different report for the same date is 409 IDEMPOTENCY_CONFLICT', async () => {
    await report(VALID, gateway());
    const answer = await report({ ...VALID, items: ITEMS.slice(0, 1) }, gateway());
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('M4-06 AZ-34 N1 no credential is 401', async () => {
    expect((await report(VALID)).status).toBe(401);
  });

  it.each([['transaction'], ['fraud'], ['notification'], ['reconciliation']])(
    'M4-06 AZ-34 N2 the service %s is POLICY_NOT_ALLOWED and nothing is stored',
    async (client) => {
      const answer = await report(VALID, service(client));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(await rows('settlement_batches')).toEqual([]);
    },
  );

  it('M4-06 AZ-34 N3 the bank itself (an account number would be in its report) is POLICY_NOT_ALLOWED', async () => {
    const answer = await report(VALID, bank());
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    expect(await rows('settlement_batches')).toEqual([]);
  });
});

describe('M4-06 FR-32 TF-13 the report is tokens and amounts, or it is refused', () => {
  const cases: [string, unknown][] = [
    [
      'an account number where a token belongs',
      { ...VALID, items: [{ ...ITEMS[0], account_pseudonym: '1234567801' }] },
    ],
    [
      'a field named account_number',
      { ...VALID, items: [{ ...ITEMS[0], account_number: '1234567801' }] },
    ],
    [
      'an identity field next to an item',
      { ...VALID, items: [{ ...ITEMS[0], nama: 'Tidak Ada' }] },
    ],
    ['an identity field at the top', { ...VALID, nik: '3174000000000001' }],
    ['no items', { ...VALID, items: [] }],
    ['an amount of zero', { ...VALID, items: [{ ...ITEMS[0], amount: 0 }] }],
    ['a negative amount', { ...VALID, items: [{ ...ITEMS[0], amount: -35_000 }] }],
    ['an amount with a fraction', { ...VALID, items: [{ ...ITEMS[0], amount: 35_000.5 }] }],
    ['an amount as text', { ...VALID, items: [{ ...ITEMS[0], amount: '35000' }] }],
    ['a lowercase bank reference', { ...VALID, items: [{ ...ITEMS[0], bank_reference: 'bnk-1' }] }],
    [
      'a bank reference of 33 characters',
      { ...VALID, items: [{ ...ITEMS[0], bank_reference: 'B'.repeat(33) }] },
    ],
    ['an empty bank reference', { ...VALID, items: [{ ...ITEMS[0], bank_reference: '' }] }],
    [
      'the same bank reference twice',
      { ...VALID, items: [ITEMS[0], { ...ITEMS[1], bank_reference: 'BNK-20261005-0001' }] },
    ],
    ['a date that does not exist', { ...VALID, batch_date: '2026-02-30' }],
    ['a date in another shape', { ...VALID, batch_date: '05-10-2026' }],
    ['no date', { items: ITEMS }],
    ['a body that is not an object', 'a string'],
  ];
  it.each(cases)('M4-06 TF-13 %s is 422 and nothing is stored', async (_label, body) => {
    const answer = await report(body, gateway());
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await rows('settlement_batches')).toEqual([]);
    expect(await rows('settlement_items')).toEqual([]);
    expect(privacy.asked).toEqual([]);
  });
});

describe('M4-06 N-27 the largest report: 500 items and 64 KiB', () => {
  // Worst case of an item: a 16-digit amount and a 32-character reference (about 125 bytes of JSON).
  const worst = (count: number) => ({
    batch_date: DATE,
    items: Array.from({ length: count }, (_, i) => ({
      account_pseudonym: A1,
      amount: Number.MAX_SAFE_INTEGER,
      bank_reference: `R${String(i).padStart(31, '0')}`,
    })),
  });

  it('M4-06 N-27 500 items of the worst size fit under 64 KiB and are accepted whole', async () => {
    const body = worst(500);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(64 * 1024);
    const answer = await report(body, gateway());
    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ batch_date: DATE, item_count: 500 });
    expect(await rows('settlement_items')).toHaveLength(500);
  });

  it('M4-06 N-27 501 items are 422 and none is stored', async () => {
    const answer = await report(worst(501), gateway());
    expect(answer.status).toBe(422);
    expect(await rows('settlement_items')).toEqual([]);
  });

  it('M4-06 N-27 a body padded above 64 KiB is 422 even when it holds one valid item', async () => {
    const padded = `${JSON.stringify({ batch_date: DATE, items: [ITEMS[0]] })}${' '.repeat(64 * 1024)}`;
    const answer = await request(app.httpServer)
      .post('/reconciliation/settlement-report')
      .set('authorization', `Bearer ${gateway()}`)
      .set('content-type', 'application/json')
      .send(padded);
    expect(answer.status).toBe(422);
    expect(await rows('settlement_items')).toEqual([]);
  });

  it('M4-06 N-27 a body just under 64 KiB of padding is still accepted: the limit is the byte count', async () => {
    const small = JSON.stringify({ batch_date: DATE, items: [ITEMS[0]] });
    const padded = `${small}${' '.repeat(64 * 1024 - small.length)}`;
    expect(Buffer.byteLength(padded)).toBe(64 * 1024);
    const answer = await request(app.httpServer)
      .post('/reconciliation/settlement-report')
      .set('authorization', `Bearer ${gateway()}`)
      .set('content-type', 'application/json')
      .send(padded);
    expect(answer.status).toBe(202);
  });
});

describe('M4-06 AZ-35 AZ-08 who may run a day', () => {
  it('M4-06 AZ-35 the Gateway for an admin runs the day and gets the batch', async () => {
    await report(VALID, gateway());
    const answer = await run({ date: DATE }, gateway(), person('admin'));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      batch_id: 'B-20261005',
      tx_count: 2,
      matched: 2,
      unmatched: 0,
      status: 'MATCHED',
    });
  });

  it.each([['auditor'], ['fraud_analyst']] as const)(
    'M4-06 AZ-08 the Gateway for a %s is FORBIDDEN_ROLE and nothing runs',
    async (role) => {
      const answer = await run({ date: DATE }, gateway(), person(role));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
      expect(transactions.dates).toEqual([]);
    },
  );

  it('M4-06 AZ-35 the Gateway without a person is FORBIDDEN_ROLE', async () => {
    const answer = await run({ date: DATE }, gateway());
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
  });

  it('M4-06 AZ-35 N1 an admin token alone is 401', async () => {
    expect((await run({ date: DATE }, undefined, person('admin'))).status).toBe(401);
  });

  it.each([['transaction'], ['fraud'], ['notification']])(
    'M4-06 AZ-35 N2 the service %s with an admin is POLICY_NOT_ALLOWED',
    async (client) => {
      const answer = await run({ date: DATE }, service(client), person('admin'));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect(transactions.dates).toEqual([]);
    },
  );

  it.each([
    ['no date', {}],
    ['a date that does not exist', { date: '2026-13-01' }],
    ['a date in another shape', { date: '2026/10/05' }],
    ['a person named in the body (the actor is the token)', { date: DATE, actor_id: 'usr-x' }],
  ])('M4-06 AZ-35 the body with %s is VALIDATION_ERROR', async (_label, body) => {
    const answer = await run(body, gateway(), person('admin'));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('M4-06 K-22 Transaction away is 503 and no batch; Privacy away is 503 and the batch is untouched', async () => {
    transactions.fail = true;
    const first = await run({ date: DATE }, gateway(), person('admin'));
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(await rows('settlement_batches')).toEqual([]);
    transactions.fail = false;
    privacy.fail = true;
    const second = await run({ date: DATE }, gateway(), person('admin'));
    expect(second.status).toBe(503);
    expect(await rows('settlement_batches')).toEqual([]);
  });

  it('M4-06 FR-32 nothing a run answers or logs is an account number or a name', async () => {
    await report(VALID, gateway());
    const answer = await run({ date: DATE }, gateway(), person('admin'));
    privacy.tokens.set('TX-10001', null);
    await run({ date: DATE }, gateway(), person('admin'));
    expect(JSON.stringify(answer.body)).not.toMatch(/\b[0-9]{10,}\b|PSEU-/);
    expect(logLines.join('\n')).not.toMatch(/\b[0-9]{10,}\b|nik|nama/i);
  });
});
