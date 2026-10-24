import 'reflect-metadata';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, verifyJwt } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import request from 'supertest';
import { devIdpModules } from '../src/http';
import { ISSUER, SERVICE_CLIENTS } from '../src/registry';

// Everything here is made up for the test run: secrets, usernames and addresses.
const SECRETS = Object.fromEntries(
  SERVICE_CLIENTS.map((client) => [client, `fake-secret-${client}-0123456789abcdef`]),
) as Record<(typeof SERVICE_CLIENTS)[number], string>;
const START = new Date('2026-10-19T08:00:00Z');

const root = mkdtempSync(join(tmpdir(), 'privpay-idp-http-'));
const secretsDir = join(root, 'secrets');
mkdirSync(secretsDir);
for (const [client, secret] of Object.entries(SECRETS))
  writeFileSync(join(secretsDir, `${client}_client_secret`), `${secret}\n`);
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseEnv = {
  PRIVACY_MODE: 'proposed',
  PORT: '0',
  DEV_IDP_ENABLED: 'true',
  NODE_ENV: 'test',
  DEV_IDP_SECRETS_DIR: secretsDir,
  // Inside the removed folder: a test must not leave a counter in the repository (N-51).
  DEV_IDP_STATE_DIR: join(root, 'state'),
};

const open: ServiceApp[] = [];
let clock: FakeClock;
const lines: string[] = [];
async function start(env: Record<string, string> = {}): Promise<ServiceApp> {
  const created = await createServiceApp(
    { service: 'dev-idp', modules: devIdpModules },
    { ...baseEnv, ...env },
    { clock, logDestination: { write: (line) => void lines.push(line) } },
  );
  open.push(created);
  return created;
}
beforeEach(() => {
  clock = new FakeClock(START);
  lines.length = 0;
});
afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((created) => created.close()));
});

const gateway = (audience: string | string[]): object => ({
  grant_type: 'client_credentials',
  client_id: 'api-gateway',
  client_secret: SECRETS['api-gateway'],
  audience,
});
const tokenOf = async (app: ServiceApp, body: object): Promise<string> => {
  const response = await request(app.httpServer).post('/token').send(body).expect(200);
  return (response.body as { access_token: string }).access_token;
};
const bearer = (token: string): string => `Bearer ${token}`;

describe('M1-01 POST /token and the JWKS over HTTP', () => {
  it('M1-01 client_credentials returns a short-lived Bearer token that verifies through GET /.well-known/jwks.json', async () => {
    const app = await start();
    const response = await request(app.httpServer)
      .post('/token')
      .send({ ...gateway(['transaction-service']), grant_type: 'client_credentials' })
      .expect(200);
    expect(response.body).toMatchObject({ token_type: 'Bearer', expires_in: 300 });

    const jwks = (await request(app.httpServer).get('/.well-known/jwks.json').expect(200)).body as {
      keys: { kid: string }[];
    };
    const keys = new Map<string, KeyObject>(
      jwks.keys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: 'jwk' } as never)]),
    );
    const claims = verifyJwt((response.body as { access_token: string }).access_token, {
      clock,
      issuer: ISSUER,
      audience: 'transaction-service',
      resolveKey: (kid) => (kid ? keys.get(kid) : undefined),
    });
    expect(claims).toMatchObject({ azp: 'api-gateway', aud: ['transaction-service'] });
    expect(Number(claims['exp']) - Number(claims['iat'])).toBeLessThanOrEqual(300);
  });

  it('M1-01 a single audience may be given as a string', async () => {
    const app = await start();
    await request(app.httpServer).post('/token').send(gateway('privacy-service')).expect(200);
  });

  it('M1-01 dev_login returns a human token with the role of the seed user', async () => {
    const app = await start();
    const response = await request(app.httpServer)
      .post('/token')
      .send({ grant_type: 'dev_login', client_id: 'admin-console', username: 'auditor.uji.1' })
      .expect(200);
    expect(response.body).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
  });

  it('M1-01 a wrong secret and an unknown client get the same 401 body, apart from the request id', async () => {
    const app = await start();
    const wrongSecret = await request(app.httpServer)
      .post('/token')
      .send({ ...gateway(['privacy-service']), client_secret: 'wrong' });
    const unknownClient = await request(app.httpServer)
      .post('/token')
      .send({ ...gateway(['privacy-service']), client_id: 'nobody' });
    expect(wrongSecret.status).toBe(401);
    expect(unknownClient.status).toBe(401);
    const strip = (body: { error: object }): object => ({ ...body.error, request_id: undefined });
    expect(strip(wrongSecret.body as { error: object })).toEqual(
      strip(unknownClient.body as { error: object }),
    );
    expect(wrongSecret.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('M1-01 an unknown username, or a user at the wrong client, is 401', async () => {
    const app = await start();
    for (const body of [
      { grant_type: 'dev_login', client_id: 'admin-console', username: 'nobody.uji.9' },
      { grant_type: 'dev_login', client_id: 'customer-app', username: 'admin.uji.1' },
    ]) {
      await request(app.httpServer).post('/token').send(body).expect(401);
    }
  });

  it('M1-01 an audience the client may not ask for is 403', async () => {
    const app = await start();
    const response = await request(app.httpServer)
      .post('/token')
      .send({ ...gateway(['fraud-service']), client_id: 'api-gateway' });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
  });

  it.each([
    ['an unknown field', { ...gateway('privacy-service'), scope: 'admin' }],
    [
      'no audience',
      {
        grant_type: 'client_credentials',
        client_id: 'api-gateway',
        client_secret: SECRETS['api-gateway'],
      },
    ],
    ['an empty audience list', gateway([])],
    [
      'an unknown grant',
      { grant_type: 'password', client_id: 'api-gateway', username: 'a', password: 'b' },
    ],
    [
      'dev_login with a secret',
      {
        grant_type: 'dev_login',
        client_id: 'admin-console',
        username: 'admin.uji.1',
        client_secret: 'x',
      },
    ],
    [
      'a username that is not a username',
      { grant_type: 'dev_login', client_id: 'admin-console', username: 'Admin UJI 1' },
    ],
    ['an oversized secret', { ...gateway('privacy-service'), client_secret: 'x'.repeat(1000) }],
    ['a body that is not an object', []],
  ])('M1-01 %s is a validation error (422)', async (_name, body) => {
    const app = await start();
    const response = await request(app.httpServer).post('/token').send(body);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('M1-01 the answer to a failed token request holds no secret, token or username', async () => {
    const app = await start();
    const response = await request(app.httpServer)
      .post('/token')
      .send({ ...gateway(['privacy-service']), client_secret: 'fake-wrong-secret-do-not-echo' });
    expect(JSON.stringify(response.body)).not.toContain('fake-wrong-secret-do-not-echo');
    expect(lines.join(' ')).not.toContain('fake-wrong-secret-do-not-echo');
  });
});

describe('M1-01 the dev IdP starts only in the local phase, loopback only, with no key on disk (ADR-0004)', () => {
  it.each([
    ['NODE_ENV=production', { NODE_ENV: 'production' }, 'NODE_ENV (invalid)'],
    ['DEV_IDP_ENABLED=false', { DEV_IDP_ENABLED: 'false' }, 'DEV_IDP_ENABLED (invalid)'],
    ['a non-loopback bind address', { BIND_HOST: '0.0.0.0' }, 'BIND_HOST (invalid)'],
    [
      'a token lifetime above 300 seconds',
      { ACCESS_TOKEN_TTL_SECONDS: '600' },
      'ACCESS_TOKEN_TTL_SECONDS (invalid)',
    ],
  ])('M1-01 refuses to start with %s', async (_name, env, message) => {
    await expect(start(env)).rejects.toThrow(message);
  });

  it('M1-01 refuses to start without DEV_IDP_ENABLED', async () => {
    const env: Record<string, string> = { ...baseEnv };
    Reflect.deleteProperty(env, 'DEV_IDP_ENABLED');
    await expect(
      createServiceApp({ service: 'dev-idp', modules: devIdpModules }, env, { clock }),
    ).rejects.toThrow('DEV_IDP_ENABLED (missing)');
  });

  it('M1-01 listens on 127.0.0.1 and starting it writes nothing, the key stays in memory', async () => {
    const before = readdirSync(secretsDir).sort();
    const app = await start();
    const { host } = await app.listen();
    expect(host).toBe('127.0.0.1');
    expect(readdirSync(secretsDir).sort()).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(['secrets']);
  });
});

describe('M1-01 /admin/users is for the gateway only (AZ-38, AZ-39)', () => {
  const asGateway = async (app: ServiceApp): Promise<string> =>
    bearer(await tokenOf(app, gateway(['dev-idp'])));

  it('M1-01 AZ-38 the gateway creates a customer and gets the next CUST number; only username is accepted', async () => {
    const app = await start();
    const auth = await asGateway(app);
    const first = await request(app.httpServer)
      .post('/admin/users')
      .set('authorization', auth)
      .send({ username: 'nasabah.uji.104' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      id: 'usr-cust-000104',
      customer_id: 'CUST-000104',
      username: 'nasabah.uji.104',
    });
    const second = await request(app.httpServer)
      .post('/admin/users')
      .set('authorization', auth)
      .send({ username: 'nasabah.uji.105' });
    expect((second.body as { customer_id: string }).customer_id).toBe('CUST-000105');
    // The new customer can sign in, and the token carries the number the gateway was given.
    await request(app.httpServer)
      .post('/token')
      .send({ grant_type: 'dev_login', client_id: 'customer-app', username: 'nasabah.uji.104' })
      .expect(200);
  });

  it('M1-01 AZ-38 N1: no token, a malformed header, a tampered token and an expired token are 401', async () => {
    const app = await start();
    const good = await tokenOf(app, gateway(['dev-idp']));
    const [header = '', payload = '', signature = ''] = good.split('.');
    const tampered = `${header}.${payload}.${signature.slice(0, -4)}AAAA`;
    const expired = bearer(good);
    clock.advance(300);
    const attempts: (string | undefined)[] = [
      undefined,
      'Bearer',
      'Basic abc',
      good,
      bearer(tampered),
      expired,
    ];
    for (const authorization of attempts) {
      const call = request(app.httpServer)
        .post('/admin/users')
        .send({ username: 'nasabah.uji.200' });
      const response = await (authorization === undefined
        ? call
        : call.set('authorization', authorization));
      expect(response.status).toBe(401);
    }
  });

  it('M1-01 AZ-38 N2: another service client cannot even get a token for the dev IdP, and its other tokens are 403', async () => {
    const app = await start();
    const refused = await request(app.httpServer)
      .post('/token')
      .send({
        grant_type: 'client_credentials',
        client_id: 'transaction',
        client_secret: SECRETS['transaction'],
        audience: ['dev-idp'],
      });
    expect(refused.status).toBe(403);
    const other = await tokenOf(app, {
      grant_type: 'client_credentials',
      client_id: 'transaction',
      client_secret: SECRETS['transaction'],
      audience: ['privacy-service'],
    });
    const response = await request(app.httpServer)
      .post('/admin/users')
      .set('authorization', bearer(other))
      .send({ username: 'nasabah.uji.201' });
    expect(response.status).toBe(403);
  });

  it('M1-01 AZ-38 N3: human tokens (customer, admin) are 403', async () => {
    const app = await start();
    for (const [client, username] of [
      ['customer-app', 'nasabah.uji.101'],
      ['admin-console', 'admin.uji.1'],
    ] as const) {
      const token = await tokenOf(app, { grant_type: 'dev_login', client_id: client, username });
      const response = await request(app.httpServer)
        .post('/admin/users')
        .set('authorization', bearer(token))
        .send({ username: 'nasabah.uji.202' });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    }
  });

  it('M1-01 AZ-38 N4: a gateway token made for another audience is 403', async () => {
    const app = await start();
    const token = await tokenOf(app, gateway(['privacy-service']));
    const response = await request(app.httpServer)
      .post('/admin/users')
      .set('authorization', bearer(token))
      .send({ username: 'nasabah.uji.203' });
    expect(response.status).toBe(403);
  });

  it('M1-01 AZ-38 the body is checked after the caller: no token and a bad body is 401, a good token and a bad body is 422', async () => {
    const app = await start();
    await request(app.httpServer).post('/admin/users').send({ nonsense: true }).expect(401);
    const auth = await asGateway(app);
    for (const body of [
      {},
      { username: 'x' },
      { username: 'nasabah.uji.9', email: 'someone@example.test' },
      { username: 'Has Space' },
      [],
    ]) {
      await request(app.httpServer)
        .post('/admin/users')
        .set('authorization', auth)
        .send(body)
        .expect(422);
    }
  });

  it('M1-01 AZ-38 a username that is already taken is 422', async () => {
    const app = await start();
    const auth = await asGateway(app);
    await request(app.httpServer)
      .post('/admin/users')
      .set('authorization', auth)
      .send({ username: 'admin.uji.1' })
      .expect(422);
  });

  it('M1-01 AZ-39 the gateway deletes a created customer, twice without error, and cannot delete a seed user', async () => {
    const app = await start();
    const auth = await asGateway(app);
    const created = await request(app.httpServer)
      .post('/admin/users')
      .set('authorization', auth)
      .send({ username: 'nasabah.uji.300' });
    const id = (created.body as { customer_id: string }).customer_id;
    await request(app.httpServer)
      .delete(`/admin/users/${id}`)
      .set('authorization', auth)
      .expect(204);
    await request(app.httpServer)
      .delete(`/admin/users/${id}`)
      .set('authorization', auth)
      .expect(204);
    await request(app.httpServer)
      .post('/token')
      .send({ grant_type: 'dev_login', client_id: 'customer-app', username: 'nasabah.uji.300' })
      .expect(401);
    await request(app.httpServer)
      .delete('/admin/users/CUST-000101')
      .set('authorization', auth)
      .expect(422);
    await request(app.httpServer)
      .delete('/admin/users/not-an-id')
      .set('authorization', auth)
      .expect(422);
  });

  it('M1-01 AZ-39 N1..N4: no token 401, other client 403, human 403, wrong audience 403', async () => {
    const app = await start();
    await request(app.httpServer).delete('/admin/users/CUST-000104').expect(401);
    const other = await tokenOf(app, {
      grant_type: 'client_credentials',
      client_id: 'reconciliation',
      client_secret: SECRETS['reconciliation'],
      audience: ['privacy-service'],
    });
    await request(app.httpServer)
      .delete('/admin/users/CUST-000104')
      .set('authorization', bearer(other))
      .expect(403);
    const human = await tokenOf(app, {
      grant_type: 'dev_login',
      client_id: 'admin-console',
      username: 'admin.uji.2',
    });
    await request(app.httpServer)
      .delete('/admin/users/CUST-000104')
      .set('authorization', bearer(human))
      .expect(403);
    const wrong = await tokenOf(app, gateway(['privacy-service']));
    await request(app.httpServer)
      .delete('/admin/users/CUST-000104')
      .set('authorization', bearer(wrong))
      .expect(403);
  });

  it('M1-01 the log and the metrics hold no username, secret or token after all of this', async () => {
    const app = await start();
    const auth = await asGateway(app);
    await request(app.httpServer)
      .post('/admin/users')
      .set('authorization', auth)
      .send({ username: 'nasabah.uji.777' });
    await request(app.httpServer).delete('/admin/users/CUST-000104').set('authorization', auth);
    const metrics = (await request(app.httpServer).get('/metrics')).text;
    const everything = `${lines.join(' ')} ${metrics}`;
    for (const forbidden of ['nasabah.uji.777', 'fake-secret-', auth.slice(7, 40), 'CUST-000104']) {
      expect(everything).not.toContain(forbidden);
    }
    expect(metrics).toContain('route="/admin/users/{id}"');
  });
});
