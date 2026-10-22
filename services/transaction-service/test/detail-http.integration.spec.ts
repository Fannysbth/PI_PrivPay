import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { transactionModules } from '../src/transaction.module';
import { neighbours } from './fakes';

// Seam: GET /transaction/{id} (spec transaction 3.4, K-18, AZ-30) over HTTP, with the service's real module on the
// real database and the IdP's keys served by a stub. A transaction that is not there is TRANSACTION_NOT_FOUND (K-02). Every
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
  db = await createTestDb(pg, { service: 'transaction', suffix: 'm407d' });
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
const detail = (id: string, token?: string) => {
  const call = request(app.httpServer).get(`/transaction/${id}`);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};
const reconciliation = () => service('reconciliation');

describe('M4-07 FR-22 the detail of one transaction for an audit (spec transaction 3.4)', () => {
  it('M4-07 FR-22 id, amount, status and times, and nothing that names a person or a token', async () => {
    const id = await seed('COMPLETED', '2026-10-05T12:05:08.000Z', 'TX-10001', 35_000);
    const answer = await detail(id, reconciliation());
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      transaction_id: id,
      amount: 35_000,
      status: 'COMPLETED',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as string,
      completed_at: '2026-10-05T12:05:08.000Z',
    });
    expect(JSON.stringify(answer.body)).not.toMatch(
      /PSEU-|customer|account|geohash|merchant|fraud/i,
    );
  });

  it.each(['HELD', 'FAILED', 'PENDING'])(
    'M4-07 FR-22 a %s transaction can be audited too, with completed_at null',
    async (status) => {
      const id = await seed(status, null);
      const answer = await detail(id, reconciliation());
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ transaction_id: id, status, completed_at: null });
    },
  );

  it('M4-07 K-02 a transaction that is not there is TRANSACTION_NOT_FOUND (404 between services)', async () => {
    const answer = await detail('TX-99999', reconciliation());
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ error: { reason: 'TRANSACTION_NOT_FOUND' } });
  });

  it.each(['abc', 'TX-', 'tx-1', 'TX-1%20OR%201=1', `TX-${'9'.repeat(31)}`])(
    'M4-07 AZ-30 the id %s is not looked up: it is VALIDATION_ERROR or a route that does not exist',
    async (id) => {
      const answer = await detail(id, reconciliation());
      expect(answer.status).toBe(422);
    },
  );
});

describe('M4-07 AZ-30 who may read one transaction', () => {
  it('M4-07 AZ-30 N1 no credential is 401', async () => {
    const id = await seed('COMPLETED', '2026-10-05T12:05:08.000Z');
    expect((await detail(id)).status).toBe(401);
  });

  it.each([['api-gateway'], ['fraud'], ['notification'], ['transaction']])(
    'M4-07 AZ-30 N2 the service %s is POLICY_NOT_ALLOWED',
    async (client) => {
      const id = await seed('COMPLETED', '2026-10-05T12:05:08.000Z');
      const answer = await detail(id, service(client));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    },
  );

  it('M4-07 AZ-30 N3 a transaction that is not there is the same refusal for a caller who may not ask', async () => {
    const answer = await detail('TX-99999', service('api-gateway'));
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
  });
});
