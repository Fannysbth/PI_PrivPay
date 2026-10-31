import { FakeClock } from '../src/clock';
import { createHttpClient, type HttpRequest, type HttpResponse } from '../src/http';
import { idpJwksSource } from '../src/jwks';
import { createIdpTokenCache, idpEndpoints, type IdpChoice } from '../src/idp';

// DK-04 ticket 1: one way to ask the IdP for a service token and for the keys, for both IdPs. The default stays the dev
// IdP, so every service behaves as before; Keycloak differs in the paths, in the form-urlencoded body, and in the keys it
// publishes (a signing key and an encryption key, with extra members).
const DEV: IdpChoice = { kind: 'dev-idp', realm: 'privpay' };
const KEYCLOAK: IdpChoice = { kind: 'keycloak', realm: 'privpay' };
const START = new Date('2026-10-31T10:00:00Z');

function recorder(answer: HttpResponse): {
  http: { request(request: HttpRequest): Promise<HttpResponse> };
  seen: HttpRequest[];
} {
  const seen: HttpRequest[] = [];
  return {
    seen,
    http: {
      request: (request) => {
        seen.push(request);
        return Promise.resolve(answer);
      },
    },
  };
}
const token = {
  status: 200,
  body: { access_token: 'tok.en.value', expires_in: 300, token_type: 'Bearer' },
};

describe('DK-04 idpEndpoints', () => {
  it('DK-04 the dev IdP keeps its paths', () => {
    expect(idpEndpoints(DEV)).toEqual({ token: '/token', jwks: '/.well-known/jwks.json' });
  });
  it('DK-04 Keycloak has the paths of its realm', () => {
    expect(idpEndpoints(KEYCLOAK)).toEqual({
      token: '/realms/privpay/protocol/openid-connect/token',
      jwks: '/realms/privpay/protocol/openid-connect/certs',
    });
  });
  it('DK-04 a realm name that is not a plain name is refused (it goes into a path)', () => {
    expect(() => idpEndpoints({ kind: 'keycloak', realm: '../master' })).toThrow(RangeError);
  });
});

describe('DK-04 createIdpTokenCache: client credentials', () => {
  const grant = {
    type: 'client-credentials',
    clientId: 'transaction',
    clientSecret: 'not-a-real-secret-0123456789',
    audience: 'privacy-service',
  } as const;

  it('DK-04 dev IdP: the JSON body with the audience, as before', async () => {
    const { http, seen } = recorder(token);
    const cache = createIdpTokenCache({ http, clock: new FakeClock(START), idp: DEV, grant });
    expect(await cache.get()).toBe('tok.en.value');
    expect(seen[0]).toMatchObject({
      service: 'idp',
      method: 'POST',
      path: '/token',
      idempotent: true,
      body: {
        grant_type: 'client_credentials',
        client_id: 'transaction',
        client_secret: grant.clientSecret,
        audience: ['privacy-service'],
      },
    });
    expect(seen[0]?.form).toBeUndefined();
  });

  it('DK-04 Keycloak: a form body on the token path of the realm; the audience comes from the roles of the account', async () => {
    const { http, seen } = recorder(token);
    const cache = createIdpTokenCache({ http, clock: new FakeClock(START), idp: KEYCLOAK, grant });
    expect(await cache.get()).toBe('tok.en.value');
    expect(seen[0]).toMatchObject({
      path: '/realms/privpay/protocol/openid-connect/token',
      form: {
        grant_type: 'client_credentials',
        client_id: 'transaction',
        client_secret: grant.clientSecret,
      },
    });
    expect(seen[0]?.body).toBeUndefined();
    expect(JSON.stringify(seen[0]?.form)).not.toContain('privacy-service');
  });

  it('DK-04 a refusal, an answer without a token, or an expiry of nothing is unavailable, never a token', async () => {
    for (const answer of [
      { status: 401, body: {} },
      { status: 200, body: { access_token: 'x.y.z' } },
      { status: 200, body: 'text' },
    ]) {
      const { http } = recorder(answer);
      const cache = createIdpTokenCache({
        http,
        clock: new FakeClock(START),
        idp: KEYCLOAK,
        grant,
      });
      await expect(cache.get()).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
    }
  });

  it('DK-04 the token is reused until shortly before it ends (NFR-21)', async () => {
    const { http, seen } = recorder(token);
    const clock = new FakeClock(START);
    const cache = createIdpTokenCache({ http, clock, idp: DEV, grant });
    await cache.get();
    clock.advance(200);
    await cache.get();
    expect(seen).toHaveLength(1);
    clock.advance(80);
    await cache.get();
    expect(seen).toHaveLength(2);
  });
});

describe('DK-04 createIdpTokenCache: the bank signs in', () => {
  const login = { type: 'login', clientId: 'bank-simulator', username: 'bank.uji.1' } as const;

  it('DK-04 dev IdP: dev_login by name, as before', async () => {
    const { http, seen } = recorder(token);
    await createIdpTokenCache({ http, clock: new FakeClock(START), idp: DEV, grant: login }).get();
    expect(seen[0]).toMatchObject({
      path: '/token',
      body: { grant_type: 'dev_login', client_id: 'bank-simulator', username: 'bank.uji.1' },
    });
  });

  it('DK-04 Keycloak: the password grant with the password of the test user', async () => {
    const { http, seen } = recorder(token);
    await createIdpTokenCache({
      http,
      clock: new FakeClock(START),
      idp: KEYCLOAK,
      grant: { ...login, password: 'not-a-real-password-0123' },
    }).get();
    expect(seen[0]).toMatchObject({
      form: {
        grant_type: 'password',
        client_id: 'bank-simulator',
        username: 'bank.uji.1',
        password: 'not-a-real-password-0123',
      },
    });
  });

  it('DK-04 Keycloak without a password is refused before anything is sent', () => {
    const { http, seen } = recorder(token);
    expect(() =>
      createIdpTokenCache({ http, clock: new FakeClock(START), idp: KEYCLOAK, grant: login }),
    ).toThrow(/password/);
    expect(seen).toHaveLength(0);
  });
});

describe('DK-04 idpJwksSource', () => {
  const sig = {
    kty: 'RSA',
    kid: 'sig-1',
    alg: 'RS256',
    use: 'sig',
    n: 'AQAB',
    e: 'AQAB',
    x5c: ['cert'],
    'x5t#S256': 'thumb',
  };
  const enc = {
    kty: 'RSA',
    kid: 'enc-1',
    alg: 'RSA-OAEP',
    use: 'enc',
    n: 'AQAB',
    e: 'AQAB',
    x5c: ['cert'],
  };

  it('DK-04 dev IdP: its path, and the answer as it is', async () => {
    const body = { keys: [{ kty: 'RSA', kid: 'k', n: 'a', e: 'b' }] };
    const { http, seen } = recorder({ status: 200, body });
    expect(await idpJwksSource(http, DEV).fetch()).toEqual(body);
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/.well-known/jwks.json' });
  });

  it('DK-04 Keycloak: only the RS256 signing key is kept, and only its public members', async () => {
    const { http, seen } = recorder({ status: 200, body: { keys: [enc, sig] } });
    expect(await idpJwksSource(http, KEYCLOAK).fetch()).toEqual({
      keys: [{ kty: 'RSA', kid: 'sig-1', alg: 'RS256', use: 'sig', n: 'AQAB', e: 'AQAB' }],
    });
    expect(seen[0]).toMatchObject({ path: '/realms/privpay/protocol/openid-connect/certs' });
  });

  it('DK-04 Keycloak: no signing key at all is not a usable JWKS, and two (a rotation) are both kept', async () => {
    await expect(
      idpJwksSource(recorder({ status: 200, body: { keys: [enc] } }).http, KEYCLOAK).fetch(),
    ).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
    const two = { ...sig, kid: 'sig-2' };
    const kept = (await idpJwksSource(
      recorder({ status: 200, body: { keys: [sig, two] } }).http,
      KEYCLOAK,
    ).fetch()) as { keys: { kid: string }[] };
    expect(kept.keys.map((key) => key.kid)).toEqual(['sig-1', 'sig-2']);
  });

  it('DK-04 a key with a private member is never copied out of the answer', async () => {
    const { http } = recorder({
      status: 200,
      body: { keys: [{ ...sig, d: 'private', p: 'private' }] },
    });
    const answer = (await idpJwksSource(http, KEYCLOAK).fetch()) as {
      keys: Record<string, unknown>[];
    };
    expect(answer.keys[0]).not.toHaveProperty('d');
    expect(answer.keys[0]).not.toHaveProperty('p');
  });
});

describe('DK-04 the shared HTTP client sends a form', () => {
  it('DK-04 form fields become a urlencoded body with the right content type, and body and form together are refused', async () => {
    const calls: { body: unknown; type: string | null }[] = [];
    const client = createHttpClient({
      baseUrls: { idp: 'http://idp.test' },
      timeoutMs: 1000,
      maxRetries: 0,
      fetch: ((_url: string, init?: RequestInit) => {
        calls.push({ body: init?.body, type: new Headers(init?.headers).get('content-type') });
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch,
    });
    await client.request({
      service: 'idp',
      method: 'POST',
      path: '/t',
      form: { a: 'x y', b: '&=' },
      idempotent: true,
    });
    expect(calls[0]).toEqual({ body: 'a=x+y&b=%26%3D', type: 'application/x-www-form-urlencoded' });
    await expect(
      client.request({
        service: 'idp',
        method: 'POST',
        path: '/t',
        form: { a: '1' },
        body: { b: 2 },
        idempotent: true,
      }),
    ).rejects.toMatchObject({ reason: 'INTERNAL_ERROR' });
  });
});

describe('DK-04 review fixes', () => {
  it('DK-04 a form with no field is a caller bug, not an empty request', async () => {
    const client = createHttpClient({
      baseUrls: { idp: 'http://idp.test' },
      timeoutMs: 1000,
      maxRetries: 0,
      fetch: () => Promise.resolve(new Response('{}')),
    });
    await expect(
      client.request({ service: 'idp', method: 'POST', path: '/t', form: {}, idempotent: true }),
    ).rejects.toMatchObject({ reason: 'INTERNAL_ERROR' });
  });
});
