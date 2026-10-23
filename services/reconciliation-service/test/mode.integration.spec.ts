import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  ROLE_SERVICES,
  signJwt,
  type PrivacyMode,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { reconciliationModules } from '../src/reconciliation.module';
import { FakeTransactions } from './fakes';

// Seam: the settlement report and the run, in each mode, with the service's real module over the database of that
// mode (M5-02, ADR-0006, N-44). In baseline the account of a transaction comes from Transaction (there is no Privacy),
// the report carries the account number, and the audit routes that need Privacy say so. Every value is invented. Needs
// PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'reconciliation-mode-test';
const ISSUER = 'privpay-dev-idp';
const DATE = '2026-10-05';
const ACCOUNT_1 = '1234567801';
const ACCOUNT_3 = '1234567803';
const TOKEN = ['PSEU', '6C3F8A21'].join('-');

let running: Running | undefined;
let dir: string;

interface Running {
  readonly db: TestDb;
  readonly app: ServiceApp;
  readonly transactions: FakeTransactions;
  /** The Gateway's service token, with the person behind the call (an admin unless said otherwise). */
  post(path: string, payload: unknown, actor?: Person): Promise<request.Response>;
  rows(table: string): Promise<Record<string, unknown>[]>;
}

type Person = 'admin' | 'auditor';

const envFor = (mode: PrivacyMode, over: Record<string, string | undefined> = {}) => ({
  PRIVACY_MODE: mode,
  PORT: '0',
  PG_HOST: pg.PG_HOST,
  PG_PORT: String(pg.PG_PORT),
  PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: ISSUER,
  RECON_DAILY_RUN_UTC: '00:10',
  ...(mode === 'proposed' ? { PRIVACY_SERVICE_URL: 'http://privacy.test' } : {}),
  TRANSACTION_SERVICE_URL: 'http://transaction.test',
  RECONCILIATION_CLIENT_SECRET_FILE: join(dir, 'reconciliation_client_secret'),
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-reconciliation-mode-'));
  writeFileSync(
    join(dir, 'reconciliation_client_secret'),
    'fake-secret-reconciliation-0123456789abcdef\n',
  );
});
afterEach(async () => {
  await running?.app.close();
  await running?.db.close();
  running = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(mode: PrivacyMode): Promise<Running> {
  const clock = new FakeClock('2026-10-06T00:10:00.000Z');
  const db = await createTestDb(pg, {
    service: 'reconciliation',
    suffix: `m502${mode.slice(0, 1)}`,
  });
  await migrate(db.owner, { root: migrations, mode });
  const transactions = new FakeTransactions();
  transactions.completed = [
    { transactionId: 'TX-10001', amount: 35_000, completedAt: '2026-10-05T09:00:00.000Z' },
    { transactionId: 'TX-10003', amount: 1_500_000, completedAt: '2026-10-05T10:00:00.000Z' },
  ];
  // What Transaction tells in baseline (N-46): the detail of a transaction names its account number.
  transactions.details = new Map([
    [
      'TX-10001',
      { transactionId: 'TX-10001', amount: 35_000, status: 'COMPLETED', accountRef: ACCOUNT_1 },
    ],
    [
      'TX-10003',
      { transactionId: 'TX-10003', amount: 1_500_000, status: 'COMPLETED', accountRef: ACCOUNT_3 },
    ],
  ]);
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
      service: 'reconciliation-service',
      // No privacy override: whichever client the mode builds is the one that answers.
      modules: reconciliationModules({ fetch: fetchStub, pools: { app: db.app }, transactions }),
    },
    envFor(mode),
    { clock },
  );
  const claims = (sub: string, azp: string, aud: string[], extra: object = {}) => {
    const iat = Math.floor(clock.now().getTime() / 1000);
    return { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub, azp, aud, ...extra };
  };
  const service = (client: string): string =>
    signJwt(claims(client, client, ['reconciliation-service']), {
      privateKey: pair.privateKey,
      kid: KID,
    });
  const person = (role: Person): string =>
    signJwt(claims(`usr-${role}`, 'admin-console', [...ROLE_SERVICES[role]], { roles: [role] }), {
      privateKey: pair.privateKey,
      kid: KID,
    });
  const send = (path: string, payload: unknown, actor: Person) =>
    request(app.httpServer)
      .post(path)
      .set('authorization', `Bearer ${service('api-gateway')}`)
      .set('x-actor-token', person(actor))
      .send(payload as object);
  return {
    db,
    app,
    transactions,
    post: (path, payload, actor = 'admin') => send(path, payload, actor),
    rows: async (table) =>
      (await db.owner.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows,
  };
}

const report = (first: string, second: string) => ({
  batch_date: DATE,
  items: [
    { account_pseudonym: first, amount: 35_000, bank_reference: 'BNK-20261005-0001' },
    { account_pseudonym: second, amount: 1_500_000, bank_reference: 'BNK-20261005-0002' },
  ],
});

describe('M5-02 FR-23 Reconciliation in baseline mode', () => {
  it('M5-02 N-44 the report is stored under the account numbers and the run matches them with the accounts Transaction names', async () => {
    running = await start('baseline');
    const received = await running.post(
      '/reconciliation/settlement-report',
      report(ACCOUNT_1, ACCOUNT_3),
    );
    expect(received.status).toBe(202);
    expect(await running.rows('settlement_items')).toMatchObject([
      { account_number: ACCOUNT_1 },
      { account_number: ACCOUNT_3 },
    ]);
    const ran = await running.post('/reconciliation/run', { date: DATE });
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ tx_count: 2, matched: 2, unmatched: 0, status: 'MATCHED' });
  });

  it('M5-02 N-44 an account the report does not hold is unmatched, as in proposed', async () => {
    running = await start('baseline');
    await running.post('/reconciliation/settlement-report', report(ACCOUNT_1, '1234567899'));
    const ran = await running.post('/reconciliation/run', { date: DATE });
    expect(ran.body).toMatchObject({ tx_count: 2, matched: 1, unmatched: 2, status: 'PARTIAL' });
  });

  it('M5-02 N-44 a token in the report is refused at the edge and nothing is stored', async () => {
    running = await start('baseline');
    const answer = await running.post(
      '/reconciliation/settlement-report',
      report(TOKEN, ACCOUNT_3),
    );
    expect(answer.status).toBe(422);
    expect(await running.rows('settlement_items')).toEqual([]);
  });

  it('M5-02 ADR-0006 the audit needs Privacy, which baseline does not have: it says so with 503 and records nothing', async () => {
    running = await start('baseline');
    const answer = await running.post(
      '/reconciliation/audit-request',
      { transaction_id: 'TX-10001', reason_code: 'DISPUTE' },
      'auditor',
    );
    expect(answer.status).toBe(503);
    expect(await running.rows('audit_requests')).toEqual([]);
  });
});

describe('M5-02 FR-23 Reconciliation in proposed mode', () => {
  it('M5-02 N-44 an account number in the report is refused at the edge and nothing is stored', async () => {
    running = await start('proposed');
    const answer = await running.post(
      '/reconciliation/settlement-report',
      report(ACCOUNT_1, ACCOUNT_3),
    );
    expect(answer.status).toBe(422);
    expect(await running.rows('settlement_items')).toEqual([]);
  });
});

describe('M5-02 ADR-0006 an inconsistent environment does not start', () => {
  const startsWith = (mode: PrivacyMode, over: Record<string, string | undefined>) =>
    createServiceApp(
      { service: 'reconciliation-service', modules: reconciliationModules() },
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
