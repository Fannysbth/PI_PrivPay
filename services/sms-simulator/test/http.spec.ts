import { generateKeyPairSync } from 'node:crypto';
import { FakeClock, signJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import request from 'supertest';
import { smsSimulatorModules } from '../src/sms-simulator.module';

// Seam: the SMS simulator over HTTP (spec notification 4, AZ-41, AZ-42), with the IdP's keys served by a stub. The
// phone numbers and the texts are invented. The simulator keeps messages in memory only and writes them nowhere else.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'sms-simulator-test';
const ISSUER = 'privpay-dev-idp';
const PHONE = '081200000042';
const TEXT = 'Transaksi Rp35000 berhasil.';

let clock: FakeClock;
let logLines: string[];
const apps: ServiceApp[] = [];

const jwt = (client: string, aud = ['sms-simulator']): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', sub: client, azp: client, aud },
    { privateKey: pair.privateKey, kid: KID },
  );
};

async function start(env: Record<string, string> = {}): Promise<ServiceApp> {
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const fetchStub: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const app = await createServiceApp(
    { service: 'sms-simulator', modules: smsSimulatorModules({ fetch: fetchStub }) },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: ISSUER,
      ...env,
    },
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
  apps.push(app);
  return app;
}

beforeEach(() => {
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  logLines = [];
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const send = (app: ServiceApp, token: string | undefined, body: unknown) => {
  const call = request(app.httpServer)
    .post('/sms')
    .send(body as object);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};
const messages = (app: ServiceApp) => request(app.httpServer).get('/__test/messages');

describe('M4-05 AZ-41 POST /sms', () => {
  it('M4-05 AZ-41 N1 no credential or an expired token is 401 and records nothing', async () => {
    const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true' });
    expect((await send(app, undefined, { to: PHONE, text: TEXT })).status).toBe(401);
    const old = jwt('notification');
    clock.advance(301);
    expect((await send(app, old, { to: PHONE, text: TEXT })).status).toBe(401);
    expect((await messages(app)).body).toEqual({ messages: [] });
  });

  it.each([['api-gateway'], ['transaction'], ['fraud'], ['reconciliation']])(
    'M4-05 AZ-41 N2 the service %s is POLICY_NOT_ALLOWED and records nothing',
    async (client) => {
      const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true' });
      const answer = await send(app, jwt(client), { to: PHONE, text: TEXT });
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { reason: 'POLICY_NOT_ALLOWED' } });
      expect((await messages(app)).body).toEqual({ messages: [] });
    },
  );

  it('M4-05 AZ-41 N2 a token meant for another service is refused', async () => {
    const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true' });
    expect(
      (await send(app, jwt('notification', ['privacy-service']), { to: PHONE, text: TEXT })).status,
    ).toBe(403);
    expect((await messages(app)).body).toEqual({ messages: [] });
  });

  it.each([
    ['an unknown field', { to: PHONE, text: TEXT, extra: 1 }],
    ['a requesting_service claim', { to: PHONE, text: TEXT, requesting_service: 'NOTIFICATION' }],
    ['a phone number of the wrong shape', { to: '12345', text: TEXT }],
    ['a phone number with a plus', { to: '+6281200000042', text: TEXT }],
    ['an empty text', { to: PHONE, text: '' }],
    ['a text over 320 characters', { to: PHONE, text: 'x'.repeat(321) }],
    ['a text that is not text', { to: PHONE, text: 5 }],
    ['a missing phone number', { text: TEXT }],
  ])('M4-05 AZ-41 N3 N4 %s is 422 and records nothing', async (_name, body) => {
    const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true' });
    const answer = await send(app, jwt('notification'), body);
    expect(answer.status).toBe(422);
    expect((await messages(app)).body).toEqual({ messages: [] });
  });

  it('M4-05 D-08 NOTIFICATION gets 202 and the message is kept in memory', async () => {
    const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true' });
    const answer = await send(app, jwt('notification'), { to: PHONE, text: TEXT });
    expect(answer.status).toBe(202);
    expect((await messages(app)).body).toEqual({ messages: [{ to: PHONE, text: TEXT }] });
  });

  it('M4-05 D-08 neither the phone number nor the text reaches the log or the metrics', async () => {
    const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true' });
    await send(app, jwt('notification'), { to: PHONE, text: TEXT });
    await send(app, jwt('notification'), { to: 'bad', text: TEXT });
    await send(app, jwt('fraud'), { to: PHONE, text: TEXT });
    await messages(app);
    const metrics = (await request(app.httpServer).get('/metrics')).text;
    const everything = `${logLines.join('\n')}\n${metrics}`;
    for (const value of [PHONE, TEXT, 'Rp35000', '8120000'])
      expect(everything).not.toContain(value);
  });

  it('M4-05 FR-20 with SMS_SIMULATOR_FAIL a message is refused with 503 and nothing is kept', async () => {
    const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true', SMS_SIMULATOR_FAIL: 'true' });
    const answer = await send(app, jwt('notification'), { to: PHONE, text: TEXT });
    expect(answer.status).toBe(503);
    expect((await messages(app)).body).toEqual({ messages: [] });
  });
});

describe('M4-05 AZ-42 the test endpoints exist only in the test environment', () => {
  // The platform answers every route that does not exist with its uniform error, 422 VALIDATION_ERROR (N-30): the spec
  // says 404, but the eight client codes have none. What counts is that the route is absent and gives nothing back.
  it.each([[undefined], ['false']])(
    'M4-05 AZ-42 with SMS_SIMULATOR_TEST_ENDPOINTS=%s the routes do not exist and the messages are not given',
    async (value) => {
      const app = await start(value === undefined ? {} : { SMS_SIMULATOR_TEST_ENDPOINTS: value });
      await send(app, jwt('notification'), { to: PHONE, text: TEXT });
      const read = await messages(app);
      const clear = await request(app.httpServer).delete('/__test/messages');
      expect([read.status, clear.status]).toEqual([422, 422]);
      expect(JSON.stringify([read.body, clear.body])).not.toContain(PHONE);
      expect(read.body).toMatchObject({ error: { reason: 'VALIDATION_ERROR' } });
    },
  );

  it.each([['TRUE'], ['1'], ['yes'], ['']])(
    'M4-05 AZ-42 the value %p is not a switch: the start fails and names only the variable',
    async (value) => {
      await expect(start({ SMS_SIMULATOR_TEST_ENDPOINTS: value })).rejects.toThrow(
        'SMS_SIMULATOR_TEST_ENDPOINTS',
      );
    },
  );

  it('M4-05 AZ-42 in the test environment DELETE empties the memory', async () => {
    const app = await start({ SMS_SIMULATOR_TEST_ENDPOINTS: 'true' });
    await send(app, jwt('notification'), { to: PHONE, text: TEXT });
    expect((await request(app.httpServer).delete('/__test/messages')).status).toBe(204);
    expect((await messages(app)).body).toEqual({ messages: [] });
  });
});
