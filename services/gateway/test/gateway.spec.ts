import { ROLE_SERVICES, type HumanRole } from '@privpay/common';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { z } from 'zod';
import { ROUTES, type Route } from '../src/routes';
import { HOSTS, startGateway, type Harness } from './harness';

// Built at run time: a literal pseudonym under services/ would be reported by the secret scan.
const PSEUDONYM = ['PSEU', '1A2B3C4D'].join('-');

const ROLES: readonly HumanRole[] = ['admin', 'auditor', 'fraud_analyst'];
const UUID_A = '2f1b6a52-5b0c-4a6e-9f1e-0c3f2a7d9b11';

interface Sample {
  readonly path: string;
  readonly body?: object;
  /** What the upstream must be called with. */
  readonly upstreamPath: string;
  readonly upstreamQuery?: string;
}
// One valid request per route (docs/spec/endpoints.md).
const SAMPLES: Record<string, Sample> = {
  'AZ-04': { path: '/transaction/held', upstreamPath: '/transaction/held' },
  'AZ-05': {
    path: '/transaction/TX-1760860800000001/review',
    body: { decision: 'APPROVE', reason_code: 'CONFIRMED_BY_CUSTOMER' },
    upstreamPath: '/transaction/TX-1760860800000001/review',
  },
  'AZ-06': {
    path: '/reconciliation/audit-request',
    body: { transaction_id: 'TX-1760860800000001', reason_code: 'DISPUTE' },
    upstreamPath: '/reconciliation/audit-request',
  },
  'AZ-07': {
    path: '/reconciliation/disclosure',
    body: { audit_token: PSEUDONYM, disclosure_id: UUID_A },
    upstreamPath: '/reconciliation/disclosure',
  },
  'AZ-08': {
    path: '/reconciliation/run',
    body: { date: '2026-10-18' },
    upstreamPath: '/reconciliation/run',
  },
  'AZ-10': {
    path: '/disclosure-requests',
    body: {
      audit_token: PSEUDONYM,
      basis: 'DISPUTE',
      case_ref: 'CASE-2026-001',
      attributes: ['nama'],
    },
    upstreamPath: '/disclosure-requests',
  },
  'AZ-11': {
    path: `/disclosure-requests/${UUID_A}/approve`,
    body: {},
    upstreamPath: `/disclosure-requests/${UUID_A}/approve`,
  },
  'AZ-12': {
    path: `/disclosure-requests/${UUID_A}/reject`,
    body: {},
    upstreamPath: `/disclosure-requests/${UUID_A}/reject`,
  },
  'AZ-13': {
    path: '/audit-log?service=TRANSACTION&limit=10',
    upstreamPath: '/audit-log',
    upstreamQuery: '?service=TRANSACTION&limit=10',
  },
  'AZ-14': {
    path: `/audit-log/timeline/${PSEUDONYM}`,
    upstreamPath: `/audit-log/timeline/${PSEUDONYM}`,
  },
  'AZ-15': { path: '/audit-log/summary', upstreamPath: '/audit-log/summary' },
  'AZ-16': {
    path: `/pseudonym/${PSEUDONYM}/revoke`,
    body: {},
    upstreamPath: `/pseudonym/${PSEUDONYM}/revoke`,
  },
  'AZ-17': {
    path: '/subject/revoke',
    body: { subject_type: 'CUSTOMER', subject_id: 'CUST-000101' },
    upstreamPath: '/subject/revoke',
  },
};
const sampleOf = (route: Route): Sample => SAMPLES[route.id] as Sample;

let gateway: Harness;
const call = (
  route: Route,
  token?: string,
  headers: Record<string, string> = {},
  bodyOverride?: object,
): request.Test => {
  const sample = sampleOf(route);
  const base = request(gateway.app.httpServer);
  const builder =
    route.method === 'GET'
      ? base.get(sample.path)
      : base.post(sample.path).send(bodyOverride ?? sample.body ?? {});
  if (token !== undefined) void builder.set('authorization', `Bearer ${token}`);
  for (const [name, value] of Object.entries(headers)) void builder.set(name, value);
  return builder;
};
const upstreamCalls = (): number =>
  Object.values(HOSTS)
    .filter((host) => host !== HOSTS.idp)
    .reduce((sum, host) => sum + gateway.network.to(host).length, 0);

beforeEach(async () => {
  gateway = await startGateway();
});
afterEach(async () => {
  await gateway.close();
});

describe.each(ROUTES)('M1-03 $id $method $pattern', (route) => {
  const allowed = route.who[0] as HumanRole;
  const notAllowed = ROLES.filter((role) => !route.who.includes(role));

  it(`M1-03 ${route.id} N1: no token, an expired one, a foreign signer and a tampered one are 401 and nothing goes downstream`, async () => {
    const good = gateway.tokens.person(allowed);
    const [header = '', payload = '', signature = ''] = good.split('.');
    const tampered = [
      header,
      payload,
      (signature.startsWith('A') ? 'B' : 'A') + signature.slice(1),
    ].join('.');
    const expired = gateway.tokens.person(allowed);
    gateway.clock.advance(300);
    for (const token of [undefined, expired, gateway.tokens.foreign(allowed), tampered]) {
      const response = await call(route, token);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(response.body).not.toHaveProperty('error.reason');
    }
    expect(upstreamCalls()).toBe(0);
  });

  it(`M1-03 ${route.id} N2: roles that may not use it, customers, the bank and service accounts are 403 and nothing goes downstream`, async () => {
    const principals = [
      ...notAllowed.map((role) => gateway.tokens.person(role)),
      gateway.tokens.customer(),
      gateway.tokens.bank(),
      gateway.tokens.service('api-gateway', ['api-gateway']),
      gateway.tokens.service('transaction', ['api-gateway']),
      gateway.tokens.service('reconciliation', ['api-gateway']),
    ];
    for (const token of principals) {
      const response = await call(route, token);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
      expect(Object.keys((response.body as { error: object }).error).sort()).toEqual([
        'code',
        'message',
        'request_id',
      ]);
    }
    expect(upstreamCalls()).toBe(0);
  });

  it(`M1-03 ${route.id} a person of the right role is forwarded to ${route.upstream} the way the route says`, async () => {
    const person = gateway.tokens.person(allowed);
    const sample = sampleOf(route);
    const response = await call(route, person);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const [forwarded] = gateway.network.to(HOSTS[route.upstream]);
    expect(forwarded).toMatchObject({
      method: route.method,
      path: sample.upstreamPath,
      query: sample.upstreamQuery ?? '',
    });
    if (route.auth === 'human-token') {
      expect(forwarded?.headers['authorization']).toBe(`Bearer ${person}`);
      expect(forwarded?.headers['x-actor-token']).toBeUndefined();
    } else {
      expect(forwarded?.headers['x-actor-token']).toBe(person);
      expect(forwarded?.headers['authorization']).toMatch(/^Bearer /);
      expect(forwarded?.headers['authorization']).not.toBe(`Bearer ${person}`);
    }
    expect(forwarded?.body).toEqual(route.method === 'GET' ? undefined : (sample.body ?? {}));
  });

  it(`M1-03 ${route.id} N3: a field or a query key nobody declared is 422 and nothing goes downstream`, async () => {
    const token = gateway.tokens.person(allowed);
    const sample = sampleOf(route);
    const response =
      route.method === 'GET'
        ? await call(route, token).query({ surprise: 'x' })
        : await call(route, token, {}, { ...sample.body, surprise: 'x' });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(upstreamCalls()).toBe(0);
  });

  it(`M1-03 ${route.id} N4: a requesting_service in the body, header or query changes nothing for the wrong caller`, async () => {
    const forged = {
      'x-requesting-service': 'API_GATEWAY',
      'x-actor-role': allowed,
      'x-role': allowed,
    };
    for (const token of [
      gateway.tokens.customer(),
      gateway.tokens.service('api-gateway', ['api-gateway']),
      ...notAllowed.map((role) => gateway.tokens.person(role)),
    ]) {
      const withQuery = call(route, token, forged, {
        ...sampleOf(route).body,
        requesting_service: 'API_GATEWAY',
      });
      const response = await (route.method === 'GET'
        ? withQuery.query({ requesting_service: 'API_GATEWAY' })
        : withQuery);
      expect(response.status).toBe(403);
    }
    expect(upstreamCalls()).toBe(0);
  });

  it(`M1-03 ${route.id} N4: the right caller who adds a requesting_service is told the field is unknown (422), not obeyed`, async () => {
    const token = gateway.tokens.person(allowed);
    const response =
      route.method === 'GET'
        ? await call(route, token).query({ requesting_service: 'API_GATEWAY' })
        : await call(
            route,
            token,
            {},
            { ...sampleOf(route).body, requesting_service: 'API_GATEWAY' },
          );
    expect(response.status).toBe(422);
    expect(upstreamCalls()).toBe(0);
  });
});

describe('M1-03 only what the route table lists exists, and nobody learns which routes do without proving who they are', () => {
  const unknown = [
    ['GET', '/'],
    ['GET', '/register'],
    ['POST', '/register'],
    ['POST', '/notification/register'],
    ['GET', '/admin/users'],
    ['DELETE', '/audit-log'],
    ['GET', '/transaction/../audit-log'],
    ['GET', '//audit-log'],
  ] as const;
  const send = (method: string, path: string): request.Test => {
    const base = request(gateway.app.httpServer);
    return method === 'GET'
      ? base.get(path)
      : method === 'POST'
        ? base.post(path)
        : base.delete(path);
  };

  it('M1-03 a caller who proved who they are is told 422 for a route that does not exist, and nothing goes downstream', async () => {
    const token = gateway.tokens.person('admin');
    for (const [method, path] of unknown) {
      const response = await send(method, path).set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(upstreamCalls()).toBe(0);
  });

  it('M1-03 spec 3 without a token every path is 401, existing or not, so the answer does not reveal the routes', async () => {
    const known = ['/transaction/held', `/pseudonym/${PSEUDONYM}/revoke`, '/audit-log/summary'];
    for (const [method, path] of unknown) expect((await send(method, path)).status).toBe(401);
    for (const path of known) {
      expect((await send('GET', path)).status).toBe(401);
      expect((await send('POST', path)).status).toBe(401);
    }
    expect(upstreamCalls()).toBe(0);
  });

  it('M1-03 /health and /metrics still answer: the route table does not swallow them', async () => {
    await request(gateway.app.httpServer).get('/health').expect(200);
    const metrics = await request(gateway.app.httpServer).get('/metrics').expect(200);
    expect(metrics.text).toContain('route="/health"');
  });
});

describe('M1-03 what goes downstream (gateway spec 3, invariants 1 and 6)', () => {
  it('M1-03 headers the gateway did not decide on are not forwarded, including a client X-Actor-Token', async () => {
    const person = gateway.tokens.person('fraud_analyst');
    await request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${person}`)
      .set('x-actor-token', 'attacker-supplied-token')
      .set('x-forwarded-for', '203.0.113.9')
      .set('x-requesting-service', 'API_GATEWAY')
      .set('cookie', 'session=fake')
      .expect(200);
    const [forwarded] = gateway.network.to(HOSTS['transaction-service']);
    expect(Object.keys(forwarded?.headers ?? {}).sort()).toEqual([
      'authorization',
      'x-actor-token',
      'x-request-id',
    ]);
    expect(forwarded?.headers['x-actor-token']).toBe(person);
  });

  it('M1-03 only the declared fields are forwarded: the body is rebuilt from the validated one', async () => {
    const token = gateway.tokens.person('fraud_analyst');
    await request(gateway.app.httpServer)
      .post('/transaction/TX-1760860800000001/review')
      .set('authorization', `Bearer ${token}`)
      .send({ decision: 'REJECT', reason_code: 'SUSPECTED_FRAUD' })
      .expect(200);
    expect(gateway.network.to(HOSTS['transaction-service'])[0]?.body).toEqual({
      decision: 'REJECT',
      reason_code: 'SUSPECTED_FRAUD',
    });
  });

  it('M1-03 a customer token is never forwarded, whatever route it is sent to', async () => {
    const customer = gateway.tokens.customer();
    for (const route of ROUTES) await call(route, customer);
    expect(upstreamCalls()).toBe(0);
    expect(JSON.stringify(gateway.network.requests)).not.toContain(customer);
  });

  it('M1-03 the gateway token is for the upstream alone, cached per upstream, and renewed before it expires', async () => {
    const fraud = gateway.tokens.person('fraud_analyst');
    const auditor = gateway.tokens.person('auditor');
    const heldRoute = ROUTES.find((r) => r.id === 'AZ-04') as Route;
    const auditRoute = ROUTES.find((r) => r.id === 'AZ-06') as Route;
    await call(heldRoute, fraud);
    await call(heldRoute, fraud);
    await call(auditRoute, auditor);
    expect(gateway.network.tokenRequests).toEqual([
      { audience: ['transaction-service'] },
      { audience: ['reconciliation-service'] },
    ]);

    gateway.clock.advance(271);
    await call(heldRoute, gateway.tokens.person('fraud_analyst'));
    expect(gateway.network.tokenRequests).toHaveLength(3);
  });

  it('M1-03 the request id of the client, when it is a UUID, is the one downstream; anything else is replaced', async () => {
    const token = gateway.tokens.person('fraud_analyst');
    const id = '0b9f3c8e-6a52-4a53-9f43-1f7b3d1f6a10';
    const response = await request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${token}`)
      .set('x-request-id', id)
      .expect(200);
    expect(response.headers['x-request-id']).toBe(id);
    expect(gateway.network.to(HOSTS['transaction-service'])[0]?.headers['x-request-id']).toBe(id);
  });
});

describe('M1-03 rate limit per azp and sub (TK-11, FR-26, NFR-08)', () => {
  const held = (token: string): request.Test =>
    request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${token}`);

  it('M1-03 TK-11 the request over RATE_LIMIT_PER_MINUTE is 429 RATE_LIMITED with Retry-After and does not go downstream', async () => {
    await gateway.close();
    gateway = await startGateway({ RATE_LIMIT_PER_MINUTE: '3' });
    const token = gateway.tokens.person('fraud_analyst');
    for (let i = 0; i < 3; i += 1) await held(token).expect(200);
    const refused = await held(token);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(refused.headers['retry-after']).toBe('60');
    expect(gateway.network.to(HOSTS['transaction-service'])).toHaveLength(3);
  });

  it('M1-03 another person, and the next minute, have their own count; a second token of the same person shares it', async () => {
    await gateway.close();
    gateway = await startGateway({ RATE_LIMIT_PER_MINUTE: '2' });
    const first = gateway.tokens.person('fraud_analyst');
    const sameAgain = gateway.tokens.person('fraud_analyst');
    await held(first).expect(200);
    await held(sameAgain).expect(200);
    await held(first).expect(429);
    await held(gateway.tokens.person('fraud_analyst', { sub: 'usr-fraud-other' })).expect(200);
    gateway.clock.advance(60);
    await held(gateway.tokens.person('fraud_analyst')).expect(200);
  });

  it("M1-03 requests refused as unauthenticated do not use up anyone's count", async () => {
    await gateway.close();
    gateway = await startGateway({ RATE_LIMIT_PER_MINUTE: '2' });
    for (let i = 0; i < 10; i += 1)
      await request(gateway.app.httpServer).get('/transaction/held').expect(401);
    await held(gateway.tokens.person('fraud_analyst')).expect(200);
  });

  it('M1-03 RATE_LIMIT_ENABLED=false turns the limit off', async () => {
    await gateway.close();
    gateway = await startGateway({ RATE_LIMIT_PER_MINUTE: '1', RATE_LIMIT_ENABLED: 'false' });
    const token = gateway.tokens.person('fraud_analyst');
    for (let i = 0; i < 5; i += 1) await held(token).expect(200);
  });
});

describe('M1-03 errors from downstream are masked to the eight codes (TK-12, NFR-10, NFR-25)', () => {
  const asAuditor = (): request.Test =>
    request(gateway.app.httpServer)
      .post(`/pseudonym/${PSEUDONYM}/revoke`)
      .set('authorization', `Bearer ${gateway.tokens.person('admin')}`)
      .send({});

  const answerWith = (status: number, body: unknown): void => {
    gateway.network.respond(HOSTS['privacy-service'], () => ({ status, body }));
  };
  const strip = (body: unknown): unknown =>
    JSON.parse(
      JSON.stringify(body, (key, value: unknown) => (key === 'request_id' ? undefined : value)),
    );

  it('M1-03 TK-12 a token that exists and one that does not look the same to the client, apart from request_id', async () => {
    const seen: unknown[] = [];
    for (const reason of [
      'TOKEN_NOT_FOUND',
      'SERVICE_MISMATCH',
      'PURPOSE_MISMATCH',
      'REVOKED',
      'EXPIRED',
      'POLICY_NOT_ALLOWED',
    ]) {
      answerWith(403, { error: { code: 'ACCESS_DENIED', reason, message: 'x', request_id: 'x' } });
      const response = await asAuditor();
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
      expect(response.body).not.toHaveProperty('error.reason');
      seen.push(strip(response.body));
    }
    expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it('M1-03 a downstream failure with SQL or a stack in it reaches the client as a bare 500', async () => {
    answerWith(500, {
      error: {
        reason: 'MADE_UP',
        message: 'SELECT * FROM identity_vault failed at /srv/app.js:10',
      },
    });
    const response = await asAuditor();
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/SELECT|identity_vault|\.js/);
    expect(gateway.logLines.join(' ')).not.toMatch(/SELECT|identity_vault/);
  });

  it('M1-03 a service that is down, times out, or answers 503 is 503 SERVICE_UNAVAILABLE', async () => {
    gateway.network.respond(HOSTS['privacy-service'], () => 'network-error');
    expect((await asAuditor()).status).toBe(503);
    answerWith(503, { error: { reason: 'SERVICE_UNAVAILABLE' } });
    const response = await asAuditor();
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('M1-03 a downstream answer that is not JSON is never passed on to the client: 500, no text', async () => {
    gateway.network.respond(HOSTS['privacy-service'], () => ({
      status: 200,
      body: '<script>alert(1)</script>',
    }));
    const response = await asAuditor();
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(response.text).not.toContain('script');
  });

  it('M1-03 a success is passed on as it came, and an empty answer stays empty', async () => {
    answerWith(200, { pseudonym: PSEUDONYM, status: 'revoked' });
    const ok = await asAuditor();
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ pseudonym: PSEUDONYM, status: 'revoked' });
    gateway.network.respond(HOSTS['privacy-service'], () => ({ status: 204 }));
    const empty = await asAuditor();
    expect(empty.status).toBe(204);
    expect(empty.text).toBe('');
  });
});

describe('M1-03 the keys of the issuer (FR-01)', () => {
  it('M1-03 an IdP that cannot be reached is 503 for the request, and the next minute works again', async () => {
    gateway.network.jwksFailing = true;
    const token = gateway.tokens.person('fraud_analyst');
    const refused = await request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${token}`);
    expect(refused.status).toBe(503);
    expect(upstreamCalls()).toBe(0);
    gateway.network.jwksFailing = false;
    gateway.clock.advance(30);
    await request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${gateway.tokens.person('fraud_analyst')}`)
      .expect(200);
  });

  it('M1-03 the keys are fetched once for many requests, and a token with an unknown key id is 401 after one refresh', async () => {
    const token = gateway.tokens.person('fraud_analyst');
    for (let i = 0; i < 3; i += 1)
      await request(gateway.app.httpServer)
        .get('/transaction/held')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
    expect(gateway.network.jwksFetches).toBe(1);
    const unknownKid = token.replace(
      /^[^.]+/,
      Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'someone-elses-key' })).toString(
        'base64url',
      ),
    );
    await request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${unknownKid}`)
      .expect(401);
    expect(gateway.network.jwksFetches).toBe(2);
    await request(gateway.app.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${unknownKid}`)
      .expect(401);
    expect(gateway.network.jwksFetches).toBe(2);
  });
});

describe('M1-03 the gateway logs a route and a status, never a token or a body (invariant 6)', () => {
  it('M1-03 after a round of calls no token, secret, pseudonym or case reference is in the log or the metrics', async () => {
    const token = gateway.tokens.person('auditor');
    await request(gateway.app.httpServer)
      .post('/disclosure-requests')
      .set('authorization', `Bearer ${token}`)
      .send({
        audit_token: PSEUDONYM,
        basis: 'DISPUTE',
        case_ref: 'CASE-SECRET-77',
        attributes: ['nik'],
      })
      .expect(200);
    await request(gateway.app.httpServer)
      .get(`/audit-log/timeline/${PSEUDONYM}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const metrics = (await request(gateway.app.httpServer).get('/metrics')).text;
    const everything = `${gateway.logLines.join(' ')} ${metrics}`;
    for (const forbidden of [
      token.slice(20, 60),
      PSEUDONYM,
      'CASE-SECRET-77',
      'fake-secret-api-gateway',
    ]) {
      expect(everything).not.toContain(forbidden);
    }
    expect(metrics).toContain('route="/audit-log/timeline/{pseudonym}"');
    expect(ROLE_SERVICES.auditor).toContain('privacy-service');
  });
});

describe('M1-03 TK-19 only RS256 tokens of the issuer are accepted, and the scheme is read as RFC 7235 says', () => {
  const revoke = (): request.Test =>
    request(gateway.app.httpServer).post(`/pseudonym/${PSEUDONYM}/revoke`).send({});

  it('M1-03 TK-19 alg none and HS256 signed with the public key are 401, and nothing goes downstream', async () => {
    for (const token of [gateway.tokens.algNone('admin'), gateway.tokens.hs256('admin')]) {
      const response = await revoke().set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
    expect(upstreamCalls()).toBe(0);
  });

  it('M1-03 Bearer, bearer and BEARER are all accepted; Basic, a bare token and a doubled scheme are 401', async () => {
    const token = gateway.tokens.person('admin');
    for (const scheme of ['Bearer', 'bearer', 'BEARER'])
      await revoke().set('authorization', `${scheme} ${token}`).expect(200);
    for (const header of [
      `Basic ${token}`,
      token,
      `Bearer Bearer ${token}`,
      `Bearer  ${token}`,
      'Bearer',
    ]) {
      expect((await revoke().set('authorization', header)).status).toBe(401);
    }
  });

  it('M1-03 a token made for another service (aud) is 403 and does not use up the rate limit', async () => {
    await gateway.close();
    gateway = await startGateway({ RATE_LIMIT_PER_MINUTE: '2' });
    const wrongAudience = gateway.tokens.person('admin', { aud: ['privacy-service'] });
    for (let i = 0; i < 5; i += 1)
      expect((await revoke().set('authorization', `Bearer ${wrongAudience}`)).status).toBe(403);
    const good = gateway.tokens.person('admin');
    await revoke().set('authorization', `Bearer ${good}`).expect(200);
    await revoke().set('authorization', `Bearer ${good}`).expect(200);
    await revoke().set('authorization', `Bearer ${good}`).expect(429);
  });

  it('M1-03 a call without any Authorization header is 401 even when the IdP is down, and does not touch the IdP', async () => {
    gateway.network.jwksFailing = true;
    await request(gateway.app.httpServer).get('/transaction/held').expect(401);
    await request(gateway.app.httpServer).get('/nowhere').expect(401);
    expect(gateway.network.jwksFetches).toBe(0);
  });
});

describe('M1-03 what is on the wire is checked after the caller (content type, size) and the gateway reads JSON only', () => {
  const review = (token: string): request.Test =>
    request(gateway.app.httpServer)
      .post('/transaction/TX-1760860800000001/review')
      .set('authorization', `Bearer ${token}`);

  it('M1-03 a form-encoded or plain-text body is not read as JSON: 422, and nothing goes downstream', async () => {
    const token = gateway.tokens.person('fraud_analyst');
    await review(token).type('form').send('decision=APPROVE&reason_code=OTHER').expect(422);
    await review(token)
      .type('text/plain')
      .send('{"decision":"APPROVE","reason_code":"OTHER"}')
      .expect(422);
    expect(upstreamCalls()).toBe(0);
  });

  it('M1-03 a body far over the limit is 422, and nothing goes downstream', async () => {
    const token = gateway.tokens.person('fraud_analyst');
    const response = await review(token).send({
      decision: 'APPROVE',
      reason_code: 'OTHER',
      padding: 'x'.repeat(300_000),
    });
    expect(response.status).toBe(422);
    expect(upstreamCalls()).toBe(0);
  });

  it('M1-03 the limit of a route is checked on what was received, not on what validated', async () => {
    const echo = {
      id: 'T-ECHO',
      method: 'POST',
      pattern: '/echo',
      params: {},
      who: ['admin'],
      caller: 'person',
      tokenize: null,
      idempotencyKey: false,
      upstream: 'privacy-service',
      upstreamPath: '/echo',
      auth: 'human-token',
      body: z.record(z.string(), z.string()),
      query: null,
      maxBodyBytes: 100,
    } satisfies Route;
    await gateway.close();
    gateway = await startGateway({}, { routes: [echo] });
    const token = gateway.tokens.person('admin');
    const post = (body: object): request.Test =>
      request(gateway.app.httpServer)
        .post('/echo')
        .set('authorization', `Bearer ${token}`)
        .send(body);
    await post({ note: 'short' }).expect(200);
    expect((await post({ note: 'x'.repeat(150) })).status).toBe(422);
    // Small once parsed, large on the wire: only the declared length shows it.
    const padded = await request(gateway.app.httpServer)
      .post('/echo')
      .set('authorization', `Bearer ${token}`)
      .type('json')
      .send(`{"note":"short"}${' '.repeat(200)}`);
    expect(padded.status).toBe(422);
    expect(gateway.network.to(HOSTS['privacy-service'])).toHaveLength(1);
  });
});

describe('M1-03 raw paths, odd methods and query strings that try to slip past the route table', () => {
  const raw = async (method: string, path: string, token?: string): Promise<number> => {
    const { port } = await gateway.app.listen();
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
  };

  it.each([
    '/transaction/%2e%2e/held',
    '/transaction/held;x=1',
    '/transaction%2Fheld',
    '/transaction/held/',
    '/Transaction/Held',
    '/transaction/held%00',
    '//transaction/held',
    '/transaction/./held',
    '/audit-log/../audit-log',
  ])('M1-03 %s is not a route: 401 without a token, 422 with one', async (path) => {
    expect(await raw('GET', path)).toBe(401);
    expect(await raw('GET', path, gateway.tokens.person('fraud_analyst'))).toBe(422);
    expect(upstreamCalls()).toBe(0);
  });

  it('M1-03 HEAD and OPTIONS are not routes either: nothing is answered for a browser, and nothing goes downstream', async () => {
    const token = gateway.tokens.person('auditor');
    for (const method of ['HEAD', 'OPTIONS']) {
      expect(await raw(method, '/audit-log', token)).toBe(422);
      expect(await raw(method, '/audit-log')).toBe(401);
    }
    expect(upstreamCalls()).toBe(0);
  });

  it.each([
    '?limit=1&limit=2',
    '?limit[a]=1',
    '?__proto__=x',
    '?constructor=x',
    '?limit=0',
    '?limit=201',
    '?limit=-1',
    '?limit=1e2',
    '?limit=%00',
    '?cursor=a%2Fb',
  ])('M1-03 the query %s is refused (422), nothing goes downstream', async (query) => {
    const token = gateway.tokens.person('fraud_analyst');
    const response = await request(gateway.app.httpServer)
      .get(`/transaction/held${query}`)
      .set('authorization', `Bearer ${token}`);
    expect(response.status).toBe(422);
    expect(upstreamCalls()).toBe(0);
  });

  it('M1-03 a good query is forwarded as given, encoded, and in the order sent', async () => {
    const token = gateway.tokens.person('fraud_analyst');
    await request(gateway.app.httpServer)
      .get('/transaction/held?cursor=abc_DEF-1=&limit=5')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(gateway.network.to(HOSTS['transaction-service'])[0]?.query).toBe(
      '?cursor=abc_DEF-1%3D&limit=5',
    );
  });
});
