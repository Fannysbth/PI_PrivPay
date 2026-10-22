import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { FakeClock, loadConfig, migrate, pgConfigSchema, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { transactionModules } from '../src/transaction.module';
import { neighbours } from './fakes';

// Seam: GET /transaction/held and POST /transaction/{id}/review over HTTP, with the service's real module on the real
// database and the IdP's keys served by a stub (AZ-04, AZ-05 at the Gateway are the same rule seen from outside;
// AZ-27 and AZ-28 are the service's own). Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'transaction-review-test';
const ISSUER = 'privpay-dev-idp';

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;
let near: ReturnType<typeof neighbours>;

const claims = (sub: string, azp: string, aud: string[], extra: object = {}) => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub, azp, aud, ...extra };
};
const service = (client: string, aud = ['transaction-service']): string =>
  signJwt(claims(client, client, aud), { privateKey: pair.privateKey, kid: KID });
const person = (role: string, sub = `usr-${role}`): string =>
  signJwt(
    claims(sub, 'admin-console', ['api-gateway', 'transaction-service', 'privacy-service'], {
      roles: [role],
    }),
    { privateKey: pair.privateKey, kid: KID },
  );

beforeEach(async () => {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  db = await createTestDb(pg, { service: 'transaction', suffix: 'm403h' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  near = neighbours();
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
      modules: transactionModules({ fetch: fetchStub, pools: { app: db.app }, neighbours: near }),
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
    },
    { clock },
  );
});
afterEach(async () => {
  await app.close();
  await db.close();
});

let sequence = 0;
async function seedHeld(): Promise<string> {
  sequence += 1;
  const id = `TX-${String(7_000 + sequence)}`;
  await db.owner.query(
    `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
        merchant_id, amount, geohash, status, fraud_decision, risk_score)
      VALUES ($1, $2, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', 2000000, 'qqgu4', 'HELD',
        'HOLD_FOR_VERIFICATION', 60)`,
    [id, ['00000000', '0000', '4000', '8000', String(sequence).padStart(12, '0')].join('-')],
  );
  return id;
}
const statusOf = async (id: string) =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [id],
    )
  ).rows[0];

const get = (path: string, token?: string, actor?: string) => {
  const call = request(app.httpServer).get(path);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  if (actor !== undefined) void call.set('x-actor-token', actor);
  return call;
};
const review = (id: string, body: unknown, token?: string, actor?: string) => {
  const call = request(app.httpServer)
    .post(`/transaction/${id}/review`)
    .send(body as object);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  if (actor !== undefined) void call.set('x-actor-token', actor);
  return call;
};
const gateway = () => service('api-gateway');
const approve = { decision: 'APPROVE', reason_code: 'CONFIRMED_BY_CUSTOMER' };

describe('M4-08 a person id longer than the 64 characters of reviewed_by', () => {
  it('M4-08 a review by a person whose sub is 65 characters is 422, not a 500, and changes nothing', async () => {
    const id = await seedHeld();
    const answer = await review(id, approve, gateway(), person('fraud_analyst', 'u'.repeat(65)));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await statusOf(id)).toMatchObject({ status: 'HELD', reviewed_by: null });
  });
});

describe('M4-03 AZ-27 GET /transaction/held', () => {
  it('M4-03 AZ-27 the analyst through the Gateway gets the list, without identity or token', async () => {
    const id = await seedHeld();
    const answer = await get('/transaction/held', gateway(), person('fraud_analyst'));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      items: [{ transaction_id: id, amount: 2_000_000 }],
      next_cursor: null,
    });
    expect(JSON.stringify(answer.body)).not.toMatch(/PSEU-|customer|account/i);
  });

  it('M4-03 AZ-27 N1 no credential, or an analyst token alone, is 401', async () => {
    expect((await get('/transaction/held')).status).toBe(401);
    expect((await get('/transaction/held', undefined, person('fraud_analyst'))).status).toBe(401);
  });

  it.each([['fraud'], ['reconciliation'], ['notification'], ['transaction']])(
    'M4-03 AZ-27 N2 the service %s is POLICY_NOT_ALLOWED',
    async (client) => {
      const answer = await get('/transaction/held', service(client), person('fraud_analyst'));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
    },
  );

  it.each([['auditor'], ['admin']])(
    'M4-03 AZ-27 N2 an actor with the role %s is FORBIDDEN_ROLE',
    async (role) => {
      const answer = await get('/transaction/held', gateway(), person(role));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
    },
  );

  it('M4-03 AZ-27 N2 no actor at all is FORBIDDEN_ROLE', async () => {
    const answer = await get('/transaction/held', gateway());
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
  });

  it.each([['limit=0'], ['limit=201'], ['limit=abc'], ['limit=1.5'], ['cursor=zzz'], ['extra=1']])(
    'M4-03 AZ-27 N3 the query %s is 422',
    async (query) => {
      const answer = await get(`/transaction/held?${query}`, gateway(), person('fraud_analyst'));
      expect(answer.status).toBe(422);
    },
  );
});

describe('M4-03 AZ-28 POST /transaction/{id}/review', () => {
  it('M4-03 AZ-28 the analyst decides, and the actor is the verified token, never the body', async () => {
    const id = await seedHeld();
    const answer = await review(id, approve, gateway(), person('fraud_analyst', 'usr-analyst-7'));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      transaction_id: id,
      status: 'COMPLETED',
      reviewed_at: '2026-10-20T08:00:00.000Z',
    });
    expect(await statusOf(id)).toMatchObject({ status: 'COMPLETED', reviewed_by: 'usr-analyst-7' });
  });

  it('M4-03 AZ-28 a second decision is 409 NOT_HELD, with the code a client may see', async () => {
    const id = await seedHeld();
    await review(id, approve, gateway(), person('fraud_analyst'));
    const again = await review(
      id,
      { decision: 'REJECT', reason_code: 'OTHER' },
      gateway(),
      person('fraud_analyst'),
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { reason: 'NOT_HELD', code: 'NOT_HELD' } });
    expect((await statusOf(id))?.status).toBe('COMPLETED');
  });

  it('M4-03 AZ-28 N1 no credential is 401 and nothing changes', async () => {
    const id = await seedHeld();
    expect((await review(id, approve)).status).toBe(401);
    expect((await statusOf(id))?.status).toBe('HELD');
  });

  it.each([['fraud'], ['reconciliation'], ['notification'], ['transaction']])(
    'M4-03 AZ-28 N2 the service %s is POLICY_NOT_ALLOWED and nothing changes',
    async (client) => {
      const id = await seedHeld();
      const answer = await review(id, approve, service(client), person('fraud_analyst'));
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect((await statusOf(id))?.status).toBe('HELD');
    },
  );

  it.each([['auditor'], ['admin'], [undefined]])(
    'M4-03 AZ-28 N2 the actor role %s (or none) is FORBIDDEN_ROLE and nothing changes',
    async (role) => {
      const id = await seedHeld();
      const answer = await review(
        id,
        approve,
        gateway(),
        role === undefined ? undefined : person(role),
      );
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'FORBIDDEN_ROLE' } });
      expect((await statusOf(id))?.status).toBe('HELD');
      expect(near.notifications.sent).toHaveLength(0);
    },
  );

  it.each([
    ['an unknown field', { ...approve, extra: 1 }],
    ['reviewed_by in the body', { ...approve, reviewed_by: 'usr-someone-else' }],
    ['requesting_service in the body', { ...approve, requesting_service: 'ADMIN_CONSOLE' }],
    ['free text', { ...approve, note: 'free text' }],
    ['a decision that does not exist', { decision: 'MAYBE', reason_code: 'OTHER' }],
    ['a reason code that does not exist', { decision: 'APPROVE', reason_code: 'BECAUSE' }],
    ['no reason code', { decision: 'APPROVE' }],
  ])('M4-03 AZ-28 N3 N4 %s is 422 and nothing changes', async (_name, body) => {
    const id = await seedHeld();
    const answer = await review(id, body, gateway(), person('fraud_analyst'));
    expect(answer.status).toBe(422);
    expect((await statusOf(id))?.status).toBe('HELD');
  });

  it('M4-03 AZ-28 a transaction id of the wrong shape is 422', async () => {
    expect((await review('not-an-id', approve, gateway(), person('fraud_analyst'))).status).toBe(
      422,
    );
  });
});
