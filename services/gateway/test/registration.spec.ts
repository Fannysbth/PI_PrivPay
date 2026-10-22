import request from 'supertest';
import { HOSTS, startGateway, type Harness } from './harness';

// Seam: the parts of POST /register (AZ-01, K-14) and POST /notification/register (AZ-02) that do not need the real IdP,
// Privacy and Notification: the limit per source address, the size, and who may call. The whole flow with the real
// services is in e2e/registration.integration.spec.ts. The form is invented.
let gateway: Harness;
afterEach(async () => {
  await gateway.close();
});

const form = {
  nik: '9999500000000070',
  nama: 'Kenari Abcdef',
  hp: '089990000070',
  email: 'canary-70@example.test',
  rekening: '9999000070',
  username: 'limit.uji.1',
};
const register = (body: object = form) =>
  request(gateway.app.httpServer).post('/register').send(body);

describe('M4-08 AZ-01 K-14 the limit of POST /register is by where the request comes from', () => {
  it('M4-08 AZ-01 the request over RATE_LIMIT_PER_MINUTE is 429 with Retry-After, and nothing goes downstream', async () => {
    gateway = await startGateway({ RATE_LIMIT_PER_MINUTE: '3' });
    for (let i = 0; i < 3; i += 1) expect((await register()).status).not.toBe(429);
    const calls = gateway.network.requests.length;
    const refused = await register();
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(gateway.network.requests.length).toBe(calls);
  });

  it('M4-08 AZ-01 the next minute counts again, and a registration does not use up the count of a person', async () => {
    gateway = await startGateway({ RATE_LIMIT_PER_MINUTE: '2' });
    await register();
    await register();
    expect((await register()).status).toBe(429);
    const person = await request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${gateway.tokens.person('fraud_analyst')}`);
    expect(person.status).toBe(200);
    gateway.clock.advance(60);
    expect((await register()).status).not.toBe(429);
  });

  it('M4-08 AZ-01 N3 N4 a form over 16 KiB, or with a field nobody declared, is 422 and nothing is called', async () => {
    gateway = await startGateway();
    const big = await register({ ...form, nama: 'x'.repeat(17 * 1024) });
    expect(big.status).toBe(422);
    const extra = await register({ ...form, role: 'admin' });
    expect(extra.status).toBe(422);
    expect(gateway.network.requests.filter((r) => r.host !== HOSTS.idp)).toEqual([]);
    expect(gateway.network.requests.filter((r) => r.path === '/admin/users')).toEqual([]);
  });

  it('M4-08 AZ-01 an IdP that does not answer as it should is 503, never a made-up success', async () => {
    gateway = await startGateway();
    const answer = await register();
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
  });
});

describe('M4-08 AZ-02 who may use POST /notification/register', () => {
  const body = { phone: '089990000071', channel: 'SMS' };
  const send = (token?: string) => {
    const call = request(gateway.app.httpServer).post('/notification/register');
    if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
    return call.send(body);
  };

  it('M4-08 AZ-02 N1 no credential is 401', async () => {
    gateway = await startGateway();
    expect((await send()).status).toBe(401);
  });

  it.each(['admin', 'auditor', 'fraud_analyst'] as const)(
    'M4-08 AZ-02 N2 a %s of the console is 403 and nothing goes downstream',
    async (role) => {
      gateway = await startGateway();
      const answer = await send(gateway.tokens.person(role));
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
      expect(gateway.network.to(HOSTS['notification-service'])).toEqual([]);
    },
  );

  it('M4-08 AZ-02 N2 the bank and a service account are 403 too', async () => {
    gateway = await startGateway();
    expect((await send(gateway.tokens.bank())).status).toBe(403);
    expect((await send(gateway.tokens.service('transaction', ['api-gateway']))).status).toBe(403);
    expect(gateway.network.to(HOSTS['notification-service'])).toEqual([]);
  });

  it('M4-08 AZ-02 a customer reaches Notification with the token of the domain from Privacy and the Gateway own token, not their own', async () => {
    gateway = await startGateway();
    gateway.network.respond(HOSTS['privacy-service'], () => ({
      status: 200,
      body: { pseudonym: 'PSEU-0A0B0C0D', expires_at: 'x', reused: false },
    }));
    gateway.network.respond(HOSTS['notification-service'], () => ({
      status: 201,
      body: { notification_domain_id: 'PSEU-0A0B0C0D', registered_at: 'x' },
    }));
    const answer = await send(gateway.tokens.customer());
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'REGISTERED' });
    const [downstream] = gateway.network.to(HOSTS['notification-service']);
    expect(downstream?.body).toEqual({
      notification_domain_id: 'PSEU-0A0B0C0D',
      phone: body.phone,
      channel: 'SMS',
    });
    expect(downstream?.headers['authorization']).not.toContain(gateway.tokens.customer());
    expect(gateway.network.to(HOSTS['privacy-service'])[0]?.body).toMatchObject({
      subject_type: 'CUSTOMER',
      subject_id: 'CUST-000101',
      target_service: 'NOTIFICATION',
      purpose: 'NOTIFICATION_REGISTRATION',
    });
  });
});
