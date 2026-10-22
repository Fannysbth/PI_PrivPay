import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { transactionModules } from '../src/transaction.module';
import { neighbours } from './fakes';

// Seam: GET /transaction/completed (spec transaction 3.4, K-18, AZ-29) over HTTP, with the service's real module on the
// real database and the IdP's keys served by a stub. The day of a transaction is the UTC date of `completed_at`. Every
// value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'transaction-completed-test';
const ISSUER = 'privpay-dev-idp';

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;

const service = (client: string, aud = ['transaction-service']): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub: client, azp: client, aud },
    { privateKey: pair.privateKey, kid: KID },
  );
};

beforeEach(async () => {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  db = await createTestDb(pg, { service: 'transaction', suffix: 'm406c' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
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
      service: 'transaction-service',
      modules: transactionModules({
        fetch: fetchStub,
        pools: { app: db.app },
        neighbours: neighbours(),
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
      FRAUD_AMOUNT_THRESHOLD: '1000000',
      PRIVACY_SERVICE_URL: 'http://privacy.test',
      FRAUD_SERVICE_URL: 'http://fraud.test',
      NOTIFICATION_SERVICE_URL: 'http://notification.test',
      TX_PENDING_TIMEOUT_SECONDS: '300',
      TX_SWEEP_INTERVAL_SECONDS: '30',
    },
    { clock },
  );
});
afterEach(async () => {
  await app.close();
  await db.close();
});

let sequence = 0;
async function seed(
  status: string,
  completedAt: string | null,
  id = `TX-${String(8_000 + sequence + 1)}`,
  amount = 35_000,
): Promise<string> {
  sequence += 1;
  await db.owner.query(
    `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
        merchant_id, amount, geohash, status, completed_at)
      VALUES ($1, $2, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', $3, 'qqgu4', $4, $5)`,
    [
      id,
      ['00000000', '0000', '4000', '8000', String(sequence).padStart(12, '0')].join('-'),
      amount,
      status,
      completedAt,
    ],
  );
  return id;
}
const completed = (query: string, token?: string) => {
  const call = request(app.httpServer).get(`/transaction/completed${query}`);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};
const reconciliation = () => service('reconciliation');
const DAY = '?date=2026-10-05';

describe('M4-06 FR-21 TF-05 the completed transactions of a day (spec transaction 3.4)', () => {
  it('M4-06 FR-21 only COMPLETED ones of that UTC date, with id, amount and time, oldest first: HELD and FAILED are not in it', async () => {
    const late = await seed('COMPLETED', '2026-10-05T14:28:04.000Z', 'TX-10003', 1_500_000);
    const early = await seed('COMPLETED', '2026-10-05T12:05:08.000Z', 'TX-10001', 35_000);
    // Rows of other statuses carry a time inside the day too, so only the status keeps them out of the list.
    await seed('HELD', '2026-10-05T11:00:00.000Z', 'TX-10002', 8_000_000);
    await seed('FAILED', '2026-10-05T11:30:00.000Z');
    await seed('PENDING', '2026-10-05T11:45:00.000Z');
    const answer = await completed(DAY, reconciliation());
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      items: [
        { transaction_id: early, amount: 35_000, completed_at: '2026-10-05T12:05:08.000Z' },
        { transaction_id: late, amount: 1_500_000, completed_at: '2026-10-05T14:28:04.000Z' },
      ],
      next_cursor: null,
    });
    expect(
      (answer.body as { items: { amount: number }[] }).items.reduce((sum, i) => sum + i.amount, 0),
    ).toBe(1_535_000);
  });

  it('M4-06 FR-21 the day is UTC and exact: its first millisecond is in, the last millisecond of the day before and the first of the next are out', async () => {
    const first = await seed('COMPLETED', '2026-10-05T00:00:00.000Z');
    const last = await seed('COMPLETED', '2026-10-05T23:59:59.999Z');
    await seed('COMPLETED', '2026-10-04T23:59:59.999Z');
    await seed('COMPLETED', '2026-10-06T00:00:00.000Z');
    const answer = await completed(DAY, reconciliation());
    expect(
      (answer.body as { items: { transaction_id: string }[] }).items.map((i) => i.transaction_id),
    ).toEqual([first, last]);
  });

  it('M4-06 FR-21 a day with nothing completed is an empty list, not an error', async () => {
    expect((await completed('?date=2026-01-01', reconciliation())).body).toEqual({
      items: [],
      next_cursor: null,
    });
  });

  it('M4-06 FR-21 pages by an opaque cursor without skipping or repeating a row, even with equal times', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seed('COMPLETED', '2026-10-05T10:00:00.000Z'));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const answer: { body: { items: { transaction_id: string }[]; next_cursor: string | null } } =
        await completed(
          `${DAY}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
          reconciliation(),
        );
      seen.push(...answer.body.items.map((i) => i.transaction_id));
      cursor = answer.body.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].sort());
  });

  it('M4-06 FR-21 S-38 nothing in the answer is a token, a customer or an account', async () => {
    await seed('COMPLETED', '2026-10-05T10:00:00.000Z');
    const answer = await completed(DAY, reconciliation());
    expect(JSON.stringify(answer.body)).not.toMatch(/PSEU-|customer|account|geohash|merchant/i);
  });
});

describe('M4-06 AZ-29 who may read the completed transactions', () => {
  it('M4-06 AZ-29 N1 no credential is 401', async () => {
    expect((await completed(DAY)).status).toBe(401);
  });

  it.each([['api-gateway'], ['fraud'], ['notification'], ['transaction']])(
    'M4-06 AZ-29 N2 the service %s is POLICY_NOT_ALLOWED',
    async (client) => {
      const answer = await completed(DAY, service(client));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    },
  );

  it('M4-06 AZ-29 N3 a token meant for another service is FORBIDDEN_ROLE (audience)', async () => {
    const answer = await completed(DAY, service('reconciliation', ['privacy-service']));
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
  });

  it.each([
    ['no date', ''],
    ['a date that does not exist', '?date=2026-02-30'],
    ['a date in another shape', '?date=05-10-2026'],
    ['an unknown parameter', `${DAY}&customer=x`],
    ['a limit of 0', `${DAY}&limit=0`],
    ['a limit over 200', `${DAY}&limit=201`],
    ['a cursor this service did not make', `${DAY}&cursor=abc`],
  ])('M4-06 AZ-29 the query with %s is VALIDATION_ERROR', async (_label, query) => {
    const answer = await completed(query, reconciliation());
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
