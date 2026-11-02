import { generateKeyPairSync, randomInt } from 'node:crypto';
import { join } from 'node:path';
import {
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  signJwt,
  type PrivacyMode,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { transactionModules } from '../src/transaction.module';
import { neighbours } from './fakes';

// Seam: what Reconciliation reads of a completed transaction (spec transaction 3.4) in each mode, over HTTP with the real
// module on the real database (G5, Tabel IV). In baseline there is no Privacy, so the only conventional way for the
// customer id, the NIK and the name to reach Reconciliation is Transaction: the completed list and the detail carry them
// beside the account number, as stored. In proposed the answers stay what they always were. The canary is built at run
// time from a random index.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'transaction-identity-reads-test';
const ISSUER = 'privpay-dev-idp';
const DAY = '?date=2026-10-05';
const AT = '2026-10-05T12:05:08.000Z';

let db: TestDb;
let clock: FakeClock;
let app: ServiceApp;

const reconciliation = (): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    {
      iss: ISSUER,
      iat,
      exp: iat + 300,
      jti: 'fake-jti',
      sub: 'reconciliation',
      azp: 'reconciliation',
      aud: ['transaction-service'],
    },
    { privateKey: pair.privateKey, kid: KID },
  );
};

async function start(mode: PrivacyMode): Promise<void> {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  db = await createTestDb(pg, { service: 'transaction', suffix: `g5r${mode.slice(0, 1)}` });
  await migrate(db.owner, { root: migrations, mode });
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
      PRIVACY_MODE: mode,
      PORT: '0',
      PG_HOST: pg.PG_HOST,
      PG_PORT: String(pg.PG_PORT),
      PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: ISSUER,
      FRAUD_AMOUNT_THRESHOLD: '1000000',
      ...(mode === 'proposed' ? { PRIVACY_SERVICE_URL: 'http://privacy.test' } : {}),
      FRAUD_SERVICE_URL: 'http://fraud.test',
      NOTIFICATION_SERVICE_URL: 'http://notification.test',
      TX_PENDING_TIMEOUT_SECONDS: '300',
      TX_SWEEP_INTERVAL_SECONDS: '30',
    },
    { clock },
  );
}
afterEach(async () => {
  await app.close();
  await db.close();
});

const get = (path: string) =>
  request(app.httpServer).get(path).set('authorization', `Bearer ${reconciliation()}`);
const KEY = ['00000000', '0000', '4000', '8000', '000000000001'].join('-');

describe('G5 baseline: the completed list and the detail carry the customer id, NIK, name and account number', () => {
  const person = buildCanary(randomInt(1000, 99_000));

  beforeEach(async () => {
    await start('baseline');
    await db.owner.query(
      `INSERT INTO transactions (transaction_id, idempotency_key, customer_id, account_number,
          merchant_id, amount, geohash, status, completed_at, nik, nama)
        VALUES ('TX-7001', $1, $2, $3, 'MRC-001', 35000, 'qqgu4', 'COMPLETED', $4, $5, $6)`,
      [KEY, person.customer_id, person.rekening, AT, person.nik, person.nama],
    );
  });

  it('G5 the completed item holds the customer id, the account number, the NIK and the name, and the e-mail and phone nowhere', async () => {
    const answer = await get(`/transaction/completed${DAY}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      items: [
        {
          transaction_id: 'TX-7001',
          amount: 35_000,
          completed_at: AT,
          customer_id: person.customer_id,
          account_number: person.rekening,
          nik: person.nik,
          nama: person.nama,
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(answer.body)).not.toContain(person.email);
    expect(JSON.stringify(answer.body)).not.toContain(person.hp);
  });

  it('G5 a transaction stored without NIK and name leaves those two out, it does not send null', async () => {
    await db.owner.query(
      `INSERT INTO transactions (transaction_id, idempotency_key, customer_id, account_number,
          merchant_id, amount, geohash, status, completed_at)
        VALUES ('TX-7002', $1, $2, $3, 'MRC-001', 35000, 'qqgu4', 'COMPLETED', $4)`,
      [
        ['00000000', '0000', '4000', '8000', '000000000002'].join('-'),
        person.customer_id,
        person.rekening,
        '2026-10-05T13:00:00.000Z',
      ],
    );
    const body = (await get(`/transaction/completed${DAY}`)).body as {
      items: Record<string, unknown>[];
    };
    expect(Object.keys(body.items[1] ?? {}).sort()).toEqual(
      ['account_number', 'amount', 'completed_at', 'customer_id', 'transaction_id'].sort(),
    );
  });

  it('G5 the detail holds the same four attributes beside the account number it already had (N-46)', async () => {
    const answer = await get('/transaction/TX-7001');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      transaction_id: 'TX-7001',
      account_number: person.rekening,
      customer_id: person.customer_id,
      nik: person.nik,
      nama: person.nama,
    });
  });

  it('G5 the pages of the list keep their keyset order with the attributes on', async () => {
    for (const n of [3, 4]) {
      await db.owner.query(
        `INSERT INTO transactions (transaction_id, idempotency_key, customer_id, account_number,
            merchant_id, amount, geohash, status, completed_at)
          VALUES ($1, $2, $3, $4, 'MRC-001', 35000, 'qqgu4', 'COMPLETED', $5)`,
        [
          `TX-700${String(n)}`,
          ['00000000', '0000', '4000', '8000', `00000000000${String(n)}`].join('-'),
          person.customer_id,
          person.rekening,
          `2026-10-05T13:0${String(n)}:00.000Z`,
        ],
      );
    }
    const first = (await get(`/transaction/completed${DAY}&limit=2`)).body as {
      items: { transaction_id: string }[];
      next_cursor: string;
    };
    expect(first.items.map((i) => i.transaction_id)).toEqual(['TX-7001', 'TX-7003']);
    const second = (
      await get(
        `/transaction/completed${DAY}&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
      )
    ).body as { items: { transaction_id: string; customer_id: string }[]; next_cursor: null };
    expect(second.items.map((i) => i.transaction_id)).toEqual(['TX-7004']);
    expect(second.items[0]?.customer_id).toBe(person.customer_id);
  });
});

describe('G5 proposed: the answers carry no identity, as before', () => {
  beforeEach(async () => {
    await start('proposed');
    await db.owner.query(
      `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
          merchant_id, amount, geohash, status, completed_at)
        VALUES ('TX-7001', $1, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', 35000, 'qqgu4', 'COMPLETED', $2)`,
      [KEY, AT],
    );
  });

  it('G5 the completed item is the three fields it always was', async () => {
    expect((await get(`/transaction/completed${DAY}`)).body).toEqual({
      items: [{ transaction_id: 'TX-7001', amount: 35_000, completed_at: AT }],
      next_cursor: null,
    });
  });

  it('G5 the detail has no account, no customer id, no NIK and no name', async () => {
    const answer = await get('/transaction/TX-7001');
    expect(answer.status).toBe(200);
    for (const key of ['account_number', 'customer_id', 'nik', 'nama']) {
      expect(answer.body).not.toHaveProperty(key);
    }
  });
});
