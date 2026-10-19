import { DomainError } from '../src/errors';
import { FakeDelay } from '../src/delay';
import { createHttpClient, type HttpRequest } from '../src/http';
import { fakeFetch, json, type Step } from './fake-fetch';

const GENERATED_ID = '11111111-1111-4111-8111-111111111111';
const GIVEN_ID = '3f2b9c1e-6d1a-4e55-9a40-0c1d8e7a2b11';
const CANARY = 'canary-body-3273015501900001';

function setup(script: Step[], overrides: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  const scripted = fakeFetch(script);
  const delay = new FakeDelay();
  const client = createHttpClient({
    baseUrls: { privacy: 'http://privacy.internal:3001' },
    timeoutMs: 30,
    maxRetries: 2,
    delay,
    random: () => 0.5,
    fetch: scripted.fetch,
    backoffBaseMs: 100,
    newRequestId: () => GENERATED_ID,
    ...overrides,
  });
  return { client, delay, calls: scripted.calls };
}

const get = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  service: 'privacy',
  method: 'GET',
  path: '/health',
  idempotent: true,
  ...over,
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail');
}

describe('M0-03 requests carry a correlation id and a JSON body (NFR-16)', () => {
  it('M0-03 generates X-Request-Id when none is given and sends JSON', async () => {
    const { client, calls } = setup([json(200, { pseudonym: 'x' })]);
    const response = await client.request({
      service: 'privacy',
      method: 'POST',
      path: '/pseudonymize',
      body: { purpose: 'PAYMENT_PROCESSING' },
      idempotent: true,
    });
    expect(response).toEqual({ status: 200, body: { pseudonym: 'x' } });
    const [call] = calls;
    expect(call?.url).toBe('http://privacy.internal:3001/pseudonymize');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('x-request-id')).toBe(GENERATED_ID);
    expect(headers.get('content-type')).toBe('application/json');
    expect(call?.init.body).toBe(JSON.stringify({ purpose: 'PAYMENT_PROCESSING' }));
  });

  it('M0-03 forwards the request id and caller headers', async () => {
    const { client, calls } = setup([json(200)]);
    await client.request(
      get({ requestId: GIVEN_ID, headers: { Authorization: 'Bearer token-1' } }),
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('x-request-id')).toBe(GIVEN_ID);
    expect(headers.get('authorization')).toBe('Bearer token-1');
  });

  it('M0-03 replaces a request id that is not a UUID instead of forwarding it', async () => {
    const { client, calls } = setup([json(200)]);
    await client.request(get({ requestId: `<script>${CANARY}` }));
    expect(new Headers(calls[0]?.init.headers).get('x-request-id')).toBe(GENERATED_ID);
  });
});

describe('M0-03 retries only idempotent requests, with backoff and jitter (NFR-12, qa E-03)', () => {
  it('M0-03 retries an idempotent request on 503 with exponential backoff and jitter', async () => {
    const { client, delay, calls } = setup([json(503), json(503), json(200)]);
    const response = await client.request(get());
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    // base 100 ms, factor 2 per attempt, jitter 0.5 + random() with random() = 0.5 -> x1.0
    expect(delay.waits).toEqual([100, 200]);
  });

  it('M0-03 spreads the backoff with jitter between 0.5x and 1.5x', async () => {
    const low = setup([json(503), json(200)], { random: () => 0 });
    await low.client.request(get());
    expect(low.delay.waits).toEqual([50]);
    const high = setup([json(503), json(200)], { random: () => 0.999 });
    await high.client.request(get());
    expect(high.delay.waits[0]).toBeCloseTo(149.9, 1);
  });

  it('M0-03 gives up after HTTP_MAX_RETRY retries with SERVICE_UNAVAILABLE', async () => {
    const { client, calls } = setup([json(503), json(502), json(504)]);
    const error = await failure(client.request(get()));
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).reason).toBe('SERVICE_UNAVAILABLE');
    expect(calls).toHaveLength(3);
  });

  it('M0-03 retries a network failure of an idempotent request', async () => {
    const { client, calls } = setup([new TypeError('fetch failed'), json(200)]);
    expect((await client.request(get())).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('M0-03 never retries a non-idempotent request, on 503 or on a network failure', async () => {
    for (const step of [json(503), new TypeError('fetch failed')]) {
      const { client, calls } = setup([step, json(200)]);
      const error = await failure(client.request(get({ method: 'POST', idempotent: false })));
      expect((error as DomainError).reason).toBe('SERVICE_UNAVAILABLE');
      expect(calls).toHaveLength(1);
    }
  });

  it('M0-03 returns 4xx responses without retrying', async () => {
    for (const status of [400, 403, 404, 409, 410, 422, 429]) {
      const { client, calls } = setup([json(status, { error: { code: 'X' } }), json(200)]);
      expect((await client.request(get())).status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it('M0-03 returns a 500 without retrying (only 502, 503, 504 are retried)', async () => {
    const { client, calls } = setup([json(500), json(200)]);
    expect((await client.request(get())).status).toBe(500);
    expect(calls).toHaveLength(1);
  });
});

describe('M0-03 timeouts end the request and count as a failed attempt (NFR-12)', () => {
  it('M0-03 aborts a request that does not answer and retries an idempotent one', async () => {
    const { client, calls } = setup(['hang', json(200)]);
    expect((await client.request(get())).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect((calls[0]?.init.signal as AbortSignal).aborted).toBe(true);
  });

  it('M0-03 fails with SERVICE_UNAVAILABLE when every attempt times out', async () => {
    const { client, calls } = setup(['hang', 'hang', 'hang']);
    const error = await failure(client.request(get()));
    expect((error as DomainError).reason).toBe('SERVICE_UNAVAILABLE');
    expect(calls).toHaveLength(3);
  });

  it('M0-03 does not retry a non-idempotent request that timed out', async () => {
    const { client, calls } = setup(['hang', json(200)]);
    const error = await failure(client.request(get({ method: 'POST', idempotent: false })));
    expect((error as DomainError).reason).toBe('SERVICE_UNAVAILABLE');
    expect(calls).toHaveLength(1);
  });
});

describe('M0-03 only configured services and plain paths are reachable (API7)', () => {
  it.each([
    'http://evil.example/steal',
    '//evil.example/steal',
    'health',
    '/health with space',
    '/a\\b',
    '/ok\r\nX-Injected: 1',
  ])('M0-03 refuses the path %j without sending anything', async (path) => {
    const { client, calls } = setup([json(200)]);
    await expect(client.request(get({ path }))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('M0-03 refuses a service that is not in the configuration', async () => {
    const { client, calls } = setup([json(200)]);
    await expect(client.request(get({ service: 'unknown' }))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('M0-03 asks fetch not to follow redirects', async () => {
    const { client, calls } = setup([json(200)]);
    await client.request(get());
    expect(calls[0]?.init.redirect).toBe('manual');
  });
});

describe('M0-03 failures never echo response content', () => {
  it('M0-03 does not put a downstream body or header value into the error', async () => {
    const { client } = setup([json(503, { detail: CANARY }), json(503), json(503)]);
    const error = await failure(client.request(get({ headers: { Authorization: CANARY } })));
    expect((error as Error).message).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });

  it('M0-03 refuses an oversized response', async () => {
    const huge = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '5000000' },
    });
    const { client } = setup([huge]);
    const error = await failure(client.request(get()));
    expect((error as DomainError).reason).toBe('SERVICE_UNAVAILABLE');
  });

  it('M0-03 returns text bodies as strings', async () => {
    const { client } = setup([new Response('plain', { status: 200 })]);
    expect(await client.request(get())).toEqual({ status: 200, body: 'plain' });
  });
});
