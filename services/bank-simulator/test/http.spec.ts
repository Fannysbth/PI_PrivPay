import { FakeClock } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import request from 'supertest';
import { bankSimulatorModules } from '../src/bank-simulator.module';

// Seam: the bank simulator over HTTP (spec reconciliation 4, AZ-40), with the dev IdP and the Gateway as stubs. The
// accounts and amounts are the fictitious ones of PRD 16. The simulator holds account numbers (a bank does) but the
// account never reaches its log, and it needs no secret: the bank user signs in at the dev IdP by name only.
const ISSUER = 'privpay-dev-idp';
const BANK_TOKEN = 'fake-bank-token';
const DATE = '2026-10-05';

let clock: FakeClock;
let logLines: string[];
let sent: { host: string; path: string; headers: Record<string, string>; body: unknown }[];
let gatewayAnswer: { status: number; body: unknown } | 'network-error';
let idpDown: boolean;
const apps: ServiceApp[] = [];

const stub: typeof fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  sent.push({
    host: url.hostname,
    path: url.pathname,
    headers,
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
  });
  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  if (url.hostname === 'idp.test') {
    return idpDown
      ? Promise.reject(new TypeError('connection refused'))
      : json(200, { access_token: BANK_TOKEN, token_type: 'Bearer', expires_in: 300 });
  }
  return gatewayAnswer === 'network-error'
    ? Promise.reject(new TypeError('connection refused'))
    : json(gatewayAnswer.status, gatewayAnswer.body);
};

async function start(env: Record<string, string> = {}): Promise<ServiceApp> {
  const app = await createServiceApp(
    { service: 'bank-simulator', modules: bankSimulatorModules({ fetch: stub }) },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: ISSUER,
      GATEWAY_URL: 'http://gateway.test',
      BANK_USERNAME: 'bank.uji.1',
      BANK_SIMULATOR_TEST_ENDPOINTS: 'true',
      ...env,
    },
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
  apps.push(app);
  return app;
}

beforeEach(() => {
  clock = new FakeClock('2026-10-06T00:10:00.000Z');
  logLines = [];
  sent = [];
  gatewayAnswer = { status: 202, body: { batch_date: DATE, item_count: 2 } };
  idpDown = false;
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const simulate = (app: ServiceApp, body: unknown) =>
  request(app.httpServer)
    .post('/simulate/settlement')
    .send(body as object);
const toGateway = () => sent.filter((call) => call.host === 'gateway.test');

describe('M4-06 TF-13 TF-16 the bank sends its report through the Gateway', () => {
  it('M4-06 TF-13 a valid report: the seed of PRD 16, as the bank user, to POST /settlement/report of the Gateway', async () => {
    const app = await start();
    const answer = await simulate(app, { batch_date: DATE });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      sent_items: 2,
      gateway_status: 202,
      gateway_body: { batch_date: DATE, item_count: 2 },
    });
    expect(sent[0]).toMatchObject({
      host: 'idp.test',
      path: '/token',
      body: { grant_type: 'dev_login', client_id: 'bank-simulator', username: 'bank.uji.1' },
    });
    expect(toGateway()).toHaveLength(1);
    expect(toGateway()[0]).toMatchObject({
      path: '/settlement/report',
      headers: { authorization: `Bearer ${BANK_TOKEN}` },
      body: {
        batch_date: DATE,
        items: [
          { account_number: '1234567801', amount: 35_000, bank_reference: 'BNK-20261005-0001' },
          { account_number: '1234567803', amount: 1_500_000, bank_reference: 'BNK-20261005-0002' },
        ],
      },
    });
  });

  it('M4-06 TF-13 an empty account number is injected, and the Gateway is the one that refuses it (422)', async () => {
    gatewayAnswer = { status: 422, body: { error: { code: 'VALIDATION_ERROR' } } };
    const app = await start();
    const answer = await simulate(app, { batch_date: DATE, inject: ['EMPTY_ACCOUNT'] });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ gateway_status: 422, sent_items: 3 });
    const items = (toGateway()[0]?.body as { items: { account_number: string }[] }).items;
    expect(items.map((item) => item.account_number)).toContain('');
  });

  it('M4-06 TF-13 a negative amount is injected', async () => {
    gatewayAnswer = { status: 422, body: { error: { code: 'VALIDATION_ERROR' } } };
    const app = await start();
    await simulate(app, { batch_date: DATE, inject: ['NEGATIVE_AMOUNT'] });
    const items = (toGateway()[0]?.body as { items: { amount: number }[] }).items;
    expect(items.map((item) => item.amount)).toContain(-1);
  });

  it('M4-06 TF-16 an item with no transaction is injected, a valid one the bank has and the platform does not', async () => {
    const app = await start();
    const answer = await simulate(app, { batch_date: DATE, inject: ['UNPAIRED'] });
    expect(answer.body).toMatchObject({ sent_items: 3, gateway_status: 202 });
    const items = (
      toGateway()[0]?.body as {
        items: { account_number: string; amount: number; bank_reference: string }[];
      }
    ).items;
    expect(items.at(-1)).toEqual({
      account_number: '1234567899',
      amount: 777_000,
      bank_reference: 'BNK-20261005-0003',
    });
  });

  it('M4-06 TF-16 all three faults at once still give every line its own bank reference', async () => {
    const app = await start();
    await simulate(app, {
      batch_date: DATE,
      inject: ['EMPTY_ACCOUNT', 'NEGATIVE_AMOUNT', 'UNPAIRED'],
    });
    const items = (toGateway()[0]?.body as { items: { bank_reference: string }[] }).items;
    expect(items).toHaveLength(5);
    expect(new Set(items.map((item) => item.bank_reference)).size).toBe(5);
  });

  it('M4-06 AZ-40 what the Gateway says is relayed as it is, a 403 included', async () => {
    gatewayAnswer = { status: 403, body: { error: { code: 'ACCESS_DENIED' } } };
    const app = await start();
    expect((await simulate(app, { batch_date: DATE })).body).toMatchObject({
      gateway_status: 403,
      gateway_body: { error: { code: 'ACCESS_DENIED' } },
    });
  });

  it('M4-06 K-22 the Gateway gone, or the IdP gone, is 503 and not a made-up success', async () => {
    const app = await start();
    gatewayAnswer = 'network-error';
    expect((await simulate(app, { batch_date: DATE })).status).toBe(503);
    gatewayAnswer = { status: 202, body: {} };
    // The first token is cached; it has to expire before the IdP being gone can be felt.
    clock.advance(301);
    idpDown = true;
    expect((await simulate(app, { batch_date: DATE })).status).toBe(503);
  });

  it.each([
    ['an unknown field', { batch_date: DATE, secret: 'x' }],
    ['a date that does not exist', { batch_date: '2026-02-30' }],
    ['a date in another shape', { batch_date: '05-10-2026' }],
    ['no date', {}],
    ['an unknown injection', { batch_date: DATE, inject: ['STEAL'] }],
    ['an injection that is not a list', { batch_date: DATE, inject: 'EMPTY_ACCOUNT' }],
  ])('M4-06 AZ-40 %s is 422 and nothing is sent', async (_label, body) => {
    const app = await start();
    const answer = await simulate(app, body);
    expect(answer.status).toBe(422);
    expect(sent).toEqual([]);
  });
});

describe('M4-06 AZ-40 the test endpoint exists only when it is asked for', () => {
  it('M4-06 AZ-40 without the switch the route is not there (the uniform 422, N-30) and nothing is sent', async () => {
    const app = await start({ BANK_SIMULATOR_TEST_ENDPOINTS: 'false' });
    const answer = await simulate(app, { batch_date: DATE });
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(sent).toEqual([]);
  });

  it('M4-06 AZ-40 an unset switch is off', async () => {
    const app = await createServiceApp(
      { service: 'bank-simulator', modules: bankSimulatorModules({ fetch: stub }) },
      {
        PRIVACY_MODE: 'proposed',
        PORT: '0',
        IDP_URL: 'http://idp.test',
        IDP_ISSUER: ISSUER,
        GATEWAY_URL: 'http://gateway.test',
        BANK_USERNAME: 'bank.uji.1',
      },
      { clock },
    );
    apps.push(app);
    expect((await simulate(app, { batch_date: DATE })).status).toBe(422);
  });

  it.each(['TRUE', '1', 'yes', ''])(
    'M4-06 AZ-40 the value %j for the switch stops the start instead of being read as on or off',
    async (value) => {
      await expect(start({ BANK_SIMULATOR_TEST_ENDPOINTS: value })).rejects.toThrow();
    },
  );

  it('M4-06 S-38 an account number of the bank never reaches the log of the simulator', async () => {
    const app = await start();
    await simulate(app, { batch_date: DATE, inject: ['UNPAIRED'] });
    expect(logLines.join('\n')).not.toMatch(/\b[0-9]{10,}\b/);
  });
});
