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
import { buildCanary, type Canary } from '../../../tests/pii-scan/canary';
import { scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { fraudModules } from '../src/fraud.module';

// Seam: G3 / G6 on the Fraud side. In baseline the edge accepts NIK, name and account number besides the customer id
// (Tabel IV: Fraud 4/6) and the baseline table keeps them; the score does not use them. Proposed refuses all three.
// Canaries are built at run time from a random index; nothing here is a real person. Needs PostgreSQL.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'fraud-identity-test';
const ISSUER = 'privpay-dev-idp';
const pick = (): Canary => buildCanary(randomInt(1000, 99_000));

const fraudEnv = (mode: PrivacyMode): Record<string, string> => ({
  PRIVACY_MODE: mode,
  PORT: '0',
  PG_HOST: pg.PG_HOST,
  PG_PORT: String(pg.PG_PORT),
  PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: ISSUER,
  FRAUD_AMOUNT_THRESHOLD: '1000000',
  FRAUD_ODD_HOUR_START: '22',
  FRAUD_ODD_HOUR_END: '6',
  FRAUD_HOLD_THRESHOLD: '50',
  FRAUD_BLOCK_THRESHOLD: '90',
  FRAUD_HISTORY_DAYS: '30',
});

interface Running {
  readonly db: TestDb;
  readonly logs: string[];
  assess(body: Record<string, unknown>): Promise<request.Response>;
  rows(): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

async function start(mode: PrivacyMode): Promise<Running> {
  const clock = new FakeClock('2026-10-23T08:00:00.000Z');
  const db = await createTestDb(pg, { service: 'fraud', suffix: `g3${mode.slice(0, 1)}` });
  await migrate(db.owner, { root: migrations, mode });
  const logs: string[] = [];
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const fetchStub: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const app: ServiceApp = await createServiceApp(
    {
      service: 'fraud-service',
      modules: fraudModules({ fetch: fetchStub, pools: { app: db.app } }),
    },
    fraudEnv(mode),
    { clock, logDestination: { write: (line) => void logs.push(line) } },
  );
  const jwt = (): string => {
    const iat = Math.floor(clock.now().getTime() / 1000);
    return signJwt(
      {
        iss: ISSUER,
        iat,
        exp: iat + 300,
        jti: 'fake-jti',
        sub: 'transaction',
        azp: 'transaction',
        aud: ['fraud-service'],
      },
      { privateKey: pair.privateKey, kid: KID },
    );
  };
  return {
    db,
    logs,
    assess: (body) =>
      request(app.httpServer)
        .post('/fraud/assess')
        .set('authorization', `Bearer ${jwt()}`)
        .send({ amount: 2_000_000, tx_hour: 23, geohash: 'qqgu7', ...body }),
    rows: async () =>
      (await db.owner.query<Record<string, unknown>>('SELECT * FROM fraud_assessments')).rows,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

describe('G3 G6 Fraud in baseline mode takes and keeps the NIK, the name and the account number', () => {
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('G3 G6 the three are accepted and kept beside the customer id, and the answer is the usual one', async () => {
    const person = pick();
    running = await start('baseline');
    const answer = await running.assess({
      pseudonym: person.customer_id,
      nik: person.nik,
      nama: person.nama,
      account_number: person.rekening,
    });
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body as object).sort()).toEqual(
      ['decision', 'prior_count', 'risk_score', 'rules_fired', 'rules_skipped'].sort(),
    );
    expect(await running.rows()).toMatchObject([
      {
        customer_id: person.customer_id,
        nik: person.nik,
        nama: person.nama,
        account_number: person.rekening,
      },
    ]);
  });

  it('G3 a call without them is still accepted and leaves the three columns empty', async () => {
    const person = pick();
    running = await start('baseline');
    expect((await running.assess({ pseudonym: person.customer_id })).status).toBe(200);
    expect(await running.rows()).toMatchObject([
      { customer_id: person.customer_id, nik: null, nama: null, account_number: null },
    ]);
  });

  it('G3 the score, the decision, the rules and the history are the same with and without them', async () => {
    const first = pick();
    const second = buildCanary((Number(first.customer_id.slice(5)) % 99_000) + 500);
    running = await start('baseline');
    // Two customers with the same history; only the second sends the three attributes.
    const history = { amount: 2_000_000, tx_hour: 13, geohash: 'qqgu7' };
    await running.assess({ pseudonym: first.customer_id, ...history });
    await running.assess({
      pseudonym: second.customer_id,
      nik: second.nik,
      nama: second.nama,
      account_number: second.rekening,
      ...history,
    });
    const without = await running.assess({
      pseudonym: first.customer_id,
      amount: 7_000_000,
      tx_hour: 23,
      geohash: 'wxyz1',
    });
    const withThem = await running.assess({
      pseudonym: second.customer_id,
      amount: 7_000_000,
      tx_hour: 23,
      geohash: 'wxyz1',
      nik: second.nik,
      nama: second.nama,
      account_number: second.rekening,
    });
    expect(without.body).toMatchObject({ risk_score: 75, decision: 'HOLD_FOR_VERIFICATION' });
    expect(withThem.body).toEqual(without.body);
  });

  it('G3 S-40 a field outside the three, the e-mail and the phone among them, is refused and nothing is stored', async () => {
    const person = pick();
    running = await start('baseline');
    for (const extra of [{ email: person.email }, { hp: person.hp }, { customer_id: 'x' }]) {
      const answer = await running.assess({ pseudonym: person.customer_id, ...extra });
      expect(answer.status).toBe(422);
    }
    expect(await running.rows()).toEqual([]);
  });

  it('G3 the three are bounded: a value far past any real length is refused', async () => {
    const person = pick();
    running = await start('baseline');
    const answer = await running.assess({
      pseudonym: person.customer_id,
      nik: 'x'.repeat(65),
    });
    expect(answer.status).toBe(422);
    expect(await running.rows()).toEqual([]);
  });

  it('G3 invariant 6 no log line holds any of the values, and the scan can see them in the dump', async () => {
    const person = pick();
    running = await start('baseline');
    await running.assess({
      pseudonym: person.customer_id,
      nik: person.nik,
      nama: person.nama,
      account_number: person.rekening,
    });
    await running.assess({ pseudonym: person.customer_id, nik: person.nik, email: person.email });
    expect(running.logs.length).toBeGreaterThan(0);
    expect(
      scanText(running.logs.join('\n'), [person], { service: 'fraud', location: 'log' }),
    ).toEqual([]);
    // Positive control: the same scan, on text that does carry them, finds them.
    const planted = `${person.nik} ${person.nama} ${person.rekening} ${person.customer_id}`;
    expect(
      scanText(planted, [person], { service: 'fraud', location: 'log' }).map((f) => f.attribute),
    ).toEqual(expect.arrayContaining(['nik', 'nama', 'rekening', 'customer_id']));
    const places = (await scanDatabase(running.db.owner, [person], 'fraud')).map(
      (finding) => finding.location,
    );
    expect(places).toEqual(
      expect.arrayContaining([
        'fraud_assessments.nik',
        'fraud_assessments.nama',
        'fraud_assessments.account_number',
        'fraud_assessments.customer_id',
      ]),
    );
  });

  it('G3 NFR-09 the runtime role writes the new columns but still cannot change or remove a row', async () => {
    running = await start('baseline');
    await expect(
      running.db.app.query('UPDATE fraud_assessments SET nik = NULL'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(running.db.app.query('DELETE FROM fraud_assessments')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('G3 G6 Fraud in proposed mode stays strict and keeps tokens only', () => {
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('G3 the NIK, the name and the account number are each refused, and nothing is stored', async () => {
    const person = pick();
    const token = ['PSEU', '7BCD04F2'].join('-');
    running = await start('proposed');
    for (const extra of [
      { nik: person.nik },
      { nama: person.nama },
      { account_number: person.rekening },
    ]) {
      expect((await running.assess({ pseudonym: token, ...extra })).status).toBe(422);
    }
    expect(await running.rows()).toEqual([]);
    expect((await running.assess({ pseudonym: token })).status).toBe(200);
    expect(Object.keys((await running.rows())[0] ?? {}).sort()).not.toEqual(
      expect.arrayContaining(['nik']),
    );
  });

  it('G6 the proposed table has no column for them and the scan finds none of the values', async () => {
    const person = pick();
    running = await start('proposed');
    await running.assess({ pseudonym: ['PSEU', '7BCD04F2'].join('-') });
    const columns = await running.db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'fraud_assessments'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names.filter((name) => ['nik', 'nama', 'account_number'].includes(name))).toEqual([]);
    expect(await scanDatabase(running.db.owner, [person], 'fraud')).toEqual([]);
    expect(
      scanText(running.logs.join('\n'), [person], { service: 'fraud', location: 'log' }),
    ).toEqual([]);
  });
});
