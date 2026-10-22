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
  safeEqual,
  signJwt,
  type HumanRole,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { privacyModules } from '../../privacy-service/src/privacy.module';
import { reconciliationModules } from '../src/reconciliation.module';
import { FakeTransactions } from './fakes';

// Seam: the day's reconciliation with nothing faked but the network, the IdP and Transaction (its adapter has its own
// tests): the real Privacy Service on its database, the real Reconciliation Service on its database. The token that
// Privacy gives for a transaction's account (D2) must be the token the Gateway asked for when it tokenised the bank's
// report (D3), or nothing would ever match (FR-32). Then the scan of spec pengujian 6 looks at what each left behind: the
// account number is in no table, log or answer of Reconciliation. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const privacyMigrations = join(__dirname, '..', '..', 'privacy-service', 'migrations');
const reconciliationMigrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'reconciliation-flow-test';
const ISSUER = 'privpay-dev-idp';
const SECRET = 'fake-secret-reconciliation-0123456789abcdef';
const person = buildCanary(52);
const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');
const DATE = '2026-10-05';

let privacyDb: TestDb;
let reconDb: TestDb;
let clock: FakeClock;
let privacy: ServiceApp | undefined;
let reconciliation: ServiceApp;
let transactions: FakeTransactions;
let dir: string;
const logs: Record<'privacy' | 'reconciliation', string[]> = { privacy: [], reconciliation: [] };

const sign = (azp: string, aud: string[]): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub: azp, azp, aud },
    { privateKey: pair.privateKey, kid: KID },
  );
};
const human = (role: HumanRole): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    {
      iss: ISSUER,
      iat,
      exp: iat + 300,
      jti: 'fake-jti',
      sub: `usr-${role}`,
      azp: 'admin-console',
      aud: [...ROLE_SERVICES[role]],
      roles: [role],
    },
    { privateKey: pair.privateKey, kid: KID },
  );
};

/** The network as the services see it: the IdP is a stub, the Privacy host is the real app (when it is up). */
const network: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
    if (body.client_id !== 'reconciliation' || !safeEqual(body.client_secret, SECRET)) {
      return json(401, { error: { code: 'UNAUTHENTICATED' } });
    }
    return json(200, {
      access_token: sign(body.client_id, body.audience),
      token_type: 'Bearer',
      expires_in: 300,
    });
  }
  if (url.hostname !== 'privacy.test' || privacy === undefined) {
    throw new TypeError('connection refused to ' + url.hostname);
  }
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const method = (init?.method ?? 'GET').toLowerCase() as 'get' | 'post';
  const agent = request(privacy.httpServer);
  const answer = await agent[method](url.pathname)
    .set(headers)
    .send(typeof init?.body === 'string' ? (JSON.parse(init.body) as object) : {});
  return new Response(answer.text === '' ? null : answer.text, {
    status: answer.status,
    headers: { 'content-type': 'application/json' },
  });
};

beforeEach(async () => {
  clock = new FakeClock('2026-10-06T00:10:00.000Z');
  logs.privacy = [];
  logs.reconciliation = [];
  privacyDb = await createTestDb(pg, { service: 'privacy', suffix: 'm406p' });
  await migrate(privacyDb.owner, { root: privacyMigrations, mode: 'proposed' });
  reconDb = await createTestDb(pg, { service: 'reconciliation', suffix: 'm406f' });
  await migrate(reconDb.owner, { root: reconciliationMigrations, mode: 'proposed' });
  dir = mkdtempSync(join(tmpdir(), 'privpay-reconciliation-flow-'));
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${hex(byte)}\n`);
  }
  writeFileSync(join(dir, 'reconciliation_client_secret'), `${SECRET}\n`);
  transactions = new FakeTransactions();

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
  reconciliation = await createServiceApp(
    {
      service: 'reconciliation-service',
      modules: reconciliationModules({
        fetch: network,
        pools: { app: reconDb.app },
        transactions,
        logDestination: { write: (line) => void logs.reconciliation.push(line) },
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
      RECONCILIATION_CLIENT_SECRET_FILE: join(dir, 'reconciliation_client_secret'),
    },
    { clock, logDestination: { write: (line) => void logs.reconciliation.push(line) } },
  );
});
afterEach(async () => {
  await reconciliation.close();
  await privacy?.close();
  privacy = undefined;
  rmSync(dir, { recursive: true, force: true });
  await reconDb.close();
  await privacyDb.close();
});

const toPrivacy = (client: string, body: object) =>
  request((privacy as ServiceApp).httpServer)
    .post('/pseudonymize')
    .set('authorization', `Bearer ${sign(client, ['privacy-service'])}`)
    .send(body);
const toReconciliation = (path: string, body: object, actor?: HumanRole) => {
  const call = request(reconciliation.httpServer)
    .post(path)
    .set('authorization', `Bearer ${sign('api-gateway', ['reconciliation-service'])}`);
  if (actor !== undefined) void call.set('x-actor-token', human(actor));
  return call.send(body);
};

/** B3: the Gateway issues the account token of a payment (P2), which is what makes the account known to Privacy. */
async function payment(transactionId: string): Promise<void> {
  const answer = await toPrivacy('api-gateway', {
    subject_type: 'ACCOUNT',
    subject_id: person.rekening,
    target_service: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transaction_id: transactionId,
  });
  expect(answer.status).toBe(200);
}
/** D3: what the Gateway asks Privacy for when it tokenises a line of the bank's report. */
async function reportToken(): Promise<string> {
  const answer = await toPrivacy('api-gateway', {
    subject_type: 'ACCOUNT',
    subject_id: person.rekening,
    target_service: 'RECONCILIATION',
    purpose: 'DAILY_RECONCILIATION',
  });
  expect(answer.status).toBe(200);
  return (answer.body as { pseudonym: string }).pseudonym;
}
const completed = (id: string, amount: number) => ({
  transactionId: id,
  amount,
  completedAt: '2026-10-05T12:05:08.000Z',
});

describe('M4-06 FR-32 TF-05 TF-13 the day on the real Privacy', () => {
  it('M4-06 FR-32 the token Privacy gives for the transaction (D2) is the token of the tokenised report (D3), so the day is MATCHED', async () => {
    await payment('TX-10001');
    const token = await reportToken();
    transactions.completed = [completed('TX-10001', 35_000)];
    const sent = await toReconciliation('/reconciliation/settlement-report', {
      batch_date: DATE,
      items: [{ account_pseudonym: token, amount: 35_000, bank_reference: 'BNK-20261005-0001' }],
    });
    expect(sent.status).toBe(202);
    const ran = await toReconciliation('/reconciliation/run', { date: DATE }, 'admin');
    expect(ran.status).toBe(200);
    expect(ran.body).toEqual({
      batch_id: 'B-20261005',
      tx_count: 1,
      matched: 1,
      unmatched: 0,
      status: 'MATCHED',
    });
  });

  it('M4-06 TF-05 a transaction Privacy has no token for is counted unmatched and the day still gets its batch', async () => {
    await payment('TX-10001');
    const token = await reportToken();
    transactions.completed = [completed('TX-10001', 35_000), completed('TX-10099', 50_000)];
    await toReconciliation('/reconciliation/settlement-report', {
      batch_date: DATE,
      items: [{ account_pseudonym: token, amount: 35_000, bank_reference: 'BNK-20261005-0001' }],
    });
    const ran = await toReconciliation('/reconciliation/run', { date: DATE }, 'admin');
    expect(ran.body).toEqual({
      batch_id: 'B-20261005',
      tx_count: 2,
      matched: 1,
      unmatched: 1,
      status: 'PARTIAL',
    });
  });

  it('M4-06 K-22 Privacy that is gone fails the run with 503 and fails closed: no batch is made from guesses', async () => {
    await payment('TX-10001');
    transactions.completed = [completed('TX-10001', 35_000)];
    await privacy?.close();
    privacy = undefined;
    const ran = await toReconciliation('/reconciliation/run', { date: DATE }, 'admin');
    expect(ran.status).toBe(503);
    expect(ran.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect((await reconDb.owner.query('SELECT 1 FROM settlement_batches')).rowCount).toBe(0);
  });

  it('M4-06 FR-32 S-38 the account number is in no table, log or answer of Reconciliation, and not in the clear in Privacy', async () => {
    await payment('TX-10001');
    const token = await reportToken();
    transactions.completed = [completed('TX-10001', 35_000)];
    const answers: unknown[] = [];
    answers.push(
      (
        await toReconciliation('/reconciliation/settlement-report', {
          batch_date: DATE,
          items: [
            { account_pseudonym: token, amount: 35_000, bank_reference: 'BNK-20261005-0001' },
          ],
        })
      ).body,
    );
    answers.push((await toReconciliation('/reconciliation/run', { date: DATE }, 'admin')).body);

    assertNoFindings(await scanDatabase(reconDb.owner, [person], 'reconciliation'));
    assertNoFindings(await scanDatabase(privacyDb.owner, [person], 'privacy'));
    for (const service of ['privacy', 'reconciliation'] as const) {
      assertNoFindings(scanText(logs[service].join('\n'), [person], { service, location: 'log' }));
    }
    assertNoFindings(
      scanText(JSON.stringify(answers), [person], {
        service: 'reconciliation',
        location: 'response',
      }),
    );
    // The control: the scan does find the number where it was put on purpose.
    expect(
      scanText(JSON.stringify({ account_number: person.rekening }), [person], {
        service: 'x',
        location: 'control',
      }),
    ).toHaveLength(1);
    // What Reconciliation keeps is the token of the account, and Privacy never gave it the account.
    const kept = await reconDb.owner.query('SELECT account_pseudonym FROM settlement_items');
    expect(kept.rows).toEqual([{ account_pseudonym: token }]);
  });
});
