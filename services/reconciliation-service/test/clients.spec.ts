import { createHttpClient, FakeDelay, type HttpClient } from '@privpay/common';
import { HttpPrivacyClient, HttpTransactionClient } from '../src/reconciliation';

// Seam: the HTTP adapters towards Transaction (D1) and Privacy (D2), through the shared client with a stub for fetch.
// NFR-12: both calls are idempotent, so a 503 is retried; what Privacy says about a missing token is not a failure.
const TOKEN = { get: () => Promise.resolve('fake-service-token') };
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(behaviour: (call: number) => Response) {
  let calls = 0;
  const seen: { url: string; body: string | undefined; authorization: string | null }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    calls += 1;
    const url = typeof input === 'string' ? input : 'request';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    seen.push({ url, body, authorization: new Headers(init?.headers).get('authorization') });
    return Promise.resolve(behaviour(calls));
  };
  const http: HttpClient = createHttpClient({
    baseUrls: {
      'privacy-service': 'http://privacy.test',
      'transaction-service': 'http://transaction.test',
    },
    timeoutMs: 3000,
    maxRetries: 2,
    delay: new FakeDelay(),
    fetch: fetchStub,
  });
  return { deps: { http, serviceToken: TOKEN }, count: () => calls, seen };
}

const page = (ids: string[], next: string | null) =>
  json(200, {
    items: ids.map((id) => ({
      transaction_id: id,
      amount: 35_000,
      completed_at: '2026-10-05T12:00:00.000Z',
    })),
    next_cursor: next,
  });

describe('M4-06 D1 the adapter towards Transaction', () => {
  it('M4-06 D1 follows the cursor to the last page and sends the service token', async () => {
    const t = setup((call) =>
      call === 1 ? page(['TX-10001'], 'abc_DEF-1') : page(['TX-10003'], null),
    );
    const all = await new HttpTransactionClient(t.deps).completedOn('2026-10-05');
    expect(all.map((x) => x.transactionId)).toEqual(['TX-10001', 'TX-10003']);
    expect(t.seen.map((s) => s.url)).toEqual([
      'http://transaction.test/transaction/completed?date=2026-10-05&limit=200',
      'http://transaction.test/transaction/completed?date=2026-10-05&limit=200&cursor=abc_DEF-1',
    ]);
    expect(t.seen.every((s) => s.authorization === 'Bearer fake-service-token')).toBe(true);
  });

  it('M4-06 K-22 a 503 is retried, then it is SERVICE_UNAVAILABLE and not an empty day', async () => {
    const t = setup(() => json(503, {}));
    await expect(new HttpTransactionClient(t.deps).completedOn('2026-10-05')).rejects.toMatchObject(
      { reason: 'SERVICE_UNAVAILABLE' },
    );
    expect(t.count()).toBe(3);
  });

  it.each([
    ['an answer of the wrong shape', () => json(200, { items: 'no' })],
    [
      'an amount that is not a whole number',
      () =>
        json(200, {
          items: [{ transaction_id: 'TX-1', amount: 1.5, completed_at: 'x' }],
          next_cursor: null,
        }),
    ],
    [
      'a transaction id of another shape',
      () =>
        json(200, {
          items: [{ transaction_id: 'x', amount: 1, completed_at: 'x' }],
          next_cursor: null,
        }),
    ],
    ['a 403', () => json(403, { error: { reason: 'POLICY_NOT_ALLOWED' } })],
  ])('M4-06 K-22 %s is SERVICE_UNAVAILABLE', async (_label, answer) => {
    const t = setup(answer);
    await expect(new HttpTransactionClient(t.deps).completedOn('2026-10-05')).rejects.toMatchObject(
      { reason: 'SERVICE_UNAVAILABLE' },
    );
  });

  it('M4-06 K-22 a cursor that never ends stops the loop as a failure, not a hang', async () => {
    const t = setup(() => page(['TX-1'], 'again'));
    await expect(new HttpTransactionClient(t.deps).completedOn('2026-10-05')).rejects.toMatchObject(
      { reason: 'SERVICE_UNAVAILABLE' },
    );
    expect(t.count()).toBe(1_000);
  });
});

describe('M4-06 D2 the adapter towards Privacy', () => {
  const client = (t: ReturnType<typeof setup>) => new HttpPrivacyClient(t.deps);

  it('M4-06 D2 asks for the account token in form 3 with the transaction id and nothing else', async () => {
    const t = setup(() =>
      json(200, { pseudonym: 'PSEU-B80D2C4F', expires_at: 'x', reused: false }),
    );
    expect(await client(t).accountToken('TX-10001')).toBe('PSEU-B80D2C4F');
    expect(JSON.parse(t.seen[0]?.body ?? '{}')).toEqual({
      subject_type: 'ACCOUNT',
      transaction_id: 'TX-10001',
      target_service: 'RECONCILIATION',
      purpose: 'DAILY_RECONCILIATION',
    });
    expect(t.seen[0]?.url).toBe('http://privacy.test/pseudonymize');
  });

  it('M4-06 TF-05 TOKEN_NOT_FOUND and REVOKED are "no token for this transaction", not a failure', async () => {
    const gone = setup(() =>
      json(404, { error: { code: 'ACCESS_DENIED', reason: 'TOKEN_NOT_FOUND' } }),
    );
    expect(await client(gone).accountToken('TX-1')).toBeNull();
    const revoked = setup(() => json(403, { error: { code: 'ACCESS_DENIED', reason: 'REVOKED' } }));
    expect(await client(revoked).accountToken('TX-1')).toBeNull();
  });

  it.each([
    ['POLICY_NOT_ALLOWED', () => json(403, { error: { reason: 'POLICY_NOT_ALLOWED' } })],
    ['a 404 with another reason', () => json(404, { error: { reason: 'SOMETHING_ELSE' } })],
    ['a 500', () => json(500, {})],
    ['an answer without a token', () => json(200, { expires_at: 'x' })],
    ['a token of another shape', () => json(200, { pseudonym: '1234567801' })],
  ])(
    'M4-06 K-22 %s is SERVICE_UNAVAILABLE, so the run stops instead of guessing',
    async (_label, answer) => {
      await expect(client(setup(answer)).accountToken('TX-1')).rejects.toMatchObject({
        reason: 'SERVICE_UNAVAILABLE',
      });
    },
  );

  it('M4-06 NFR-12 a 503 is retried: asking for the same token again is safe', async () => {
    const t = setup((call) =>
      call < 3
        ? json(503, {})
        : json(200, { pseudonym: 'PSEU-B80D2C4F', expires_at: 'x', reused: true }),
    );
    expect(await client(t).accountToken('TX-1')).toBe('PSEU-B80D2C4F');
    expect(t.count()).toBe(3);
  });
});
