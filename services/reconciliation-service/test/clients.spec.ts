import { createHttpClient, FakeDelay, type HttpClient } from '@privpay/common';
import { HttpPrivacyClient, HttpTransactionClient } from '../src/reconciliation';

// Seam: the HTTP adapters towards Transaction (D1) and Privacy (D2), through the shared client with a stub for fetch.
// NFR-12: both calls are idempotent, so a 503 is retried; what Privacy says about a missing token is not a failure.
const TOKEN = { get: () => Promise.resolve('fake-service-token') };
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(behaviour: (call: number) => Response) {
  let calls = 0;
  const seen: {
    url: string;
    body: string | undefined;
    authorization: string | null;
    actor: string | null;
  }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    calls += 1;
    const url = typeof input === 'string' ? input : 'request';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers = new Headers(init?.headers);
    seen.push({
      url,
      body,
      authorization: headers.get('authorization'),
      actor: headers.get('x-actor-token'),
    });
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

describe('M4-07 E1 the adapter towards Transaction for one transaction', () => {
  const detail = { transaction_id: 'TX-10001', amount: 35_000, status: 'COMPLETED' };

  it('M4-07 E1 reads the transaction by id with the service token and keeps amount and status only', async () => {
    const t = setup(() => json(200, { ...detail, created_at: 'x', completed_at: 'y' }));
    expect(await new HttpTransactionClient(t.deps).byId('TX-10001')).toEqual({
      transactionId: 'TX-10001',
      amount: 35_000,
      status: 'COMPLETED',
    });
    expect(t.seen[0]?.url).toBe('http://transaction.test/transaction/TX-10001');
    expect(t.seen[0]?.authorization).toBe('Bearer fake-service-token');
  });

  it('M4-07 K-02 a 404 TRANSACTION_NOT_FOUND keeps its own reason, anything else is SERVICE_UNAVAILABLE', async () => {
    const gone = setup(() => json(404, { error: { reason: 'TRANSACTION_NOT_FOUND' } }));
    await expect(new HttpTransactionClient(gone.deps).byId('TX-1')).rejects.toMatchObject({
      reason: 'TRANSACTION_NOT_FOUND',
    });
    const other = setup(() => json(404, { error: { reason: 'SOMETHING_ELSE' } }));
    await expect(new HttpTransactionClient(other.deps).byId('TX-1')).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
    const odd = setup(() => json(200, { ...detail, status: 'WHATEVER' }));
    await expect(new HttpTransactionClient(odd.deps).byId('TX-1')).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
  });

  it('M4-07 NFR-12 a 503 is retried: reading is safe to repeat', async () => {
    const t = setup((call) => (call < 3 ? json(503, {}) : json(200, detail)));
    await new HttpTransactionClient(t.deps).byId('TX-10001');
    expect(t.count()).toBe(3);
  });
});

describe('M4-07 E2 the adapter towards Privacy for the audit token', () => {
  const actor = { actorId: 'usr-auditor', token: 'fake-actor-token' };
  const client = (t: ReturnType<typeof setup>) => new HttpPrivacyClient(t.deps);

  it('M4-07 E2 asks form 3 for the customer of the transaction with the actor token of the person', async () => {
    const t = setup(() =>
      json(200, { pseudonym: 'PSEU-6C3F8A21', expires_at: 'x', reused: false }),
    );
    expect(await client(t).auditToken('TX-10001', actor)).toBe('PSEU-6C3F8A21');
    expect(JSON.parse(t.seen[0]?.body ?? '{}')).toEqual({
      subject_type: 'CUSTOMER',
      transaction_id: 'TX-10001',
      target_service: 'RECONCILIATION',
      purpose: 'INTERNAL_AUDIT',
    });
    expect(t.seen[0]?.actor).toBe('fake-actor-token');
    expect(t.seen[0]?.authorization).toBe('Bearer fake-service-token');
  });

  it.each([
    ['TOKEN_NOT_FOUND', 404],
    ['FORBIDDEN_ROLE', 403],
    ['REVOKED', 403],
    ['POLICY_NOT_ALLOWED', 403],
  ])('M4-07 E2 the refusal %s of Privacy is thrown with its own reason', async (reason, status) => {
    const t = setup(() => json(status, { error: { code: 'ACCESS_DENIED', reason } }));
    await expect(client(t).auditToken('TX-1', actor)).rejects.toMatchObject({ reason });
  });

  it.each([
    ['a 401', () => json(401, { error: { reason: 'UNAUTHENTICATED' } })],
    ['a 429', () => json(429, { error: { reason: 'RATE_LIMITED' } })],
    ['a 422 of ours', () => json(422, { error: { reason: 'VALIDATION_ERROR' } })],
    ['a reason that does not exist', () => json(403, { error: { reason: 'MADE_UP' } })],
    ['an answer without a reason', () => json(403, {})],
  ])(
    'M4-07 NFR-10 %s is SERVICE_UNAVAILABLE, not something said about the person',
    async (_label, answer) => {
      await expect(client(setup(answer)).auditToken('TX-1', actor)).rejects.toMatchObject({
        reason: 'SERVICE_UNAVAILABLE',
      });
    },
  );

  it('M4-07 NFR-12 a 503 is retried: asking for the same token again is safe', async () => {
    const t = setup((call) =>
      call < 3
        ? json(503, {})
        : json(200, { pseudonym: 'PSEU-6C3F8A21', expires_at: 'x', reused: true }),
    );
    expect(await client(t).auditToken('TX-1', actor)).toBe('PSEU-6C3F8A21');
    expect(t.count()).toBe(3);
  });
});

describe('M4-07 E3 the adapter towards Privacy for the opening of an identity', () => {
  const actor = { actorId: 'usr-auditor', token: 'fake-actor-token' };
  const request = {
    auditToken: ['PSEU', '6C3F8A21'].join('-'),
    disclosureId: '5f2b9b0e-2d57-4b1e-8c3a-0b7f6a1d4c11',
  };
  const client = (t: ReturnType<typeof setup>) => new HttpPrivacyClient(t.deps);

  it('M4-07 FR-09 sends the token, the fixed purpose and the approved request, with the actor token of the person', async () => {
    const t = setup(() => json(200, { mapping_id: 'x', attributes: { nama: 'Kenari Abcdef' } }));
    expect(await client(t).open(request, actor)).toEqual({ nama: 'Kenari Abcdef' });
    expect(JSON.parse(t.seen[0]?.body ?? '{}')).toEqual({
      pseudonym: 'PSEU-6C3F8A21',
      purpose: 'INTERNAL_AUDIT',
      disclosure_id: request.disclosureId,
    });
    expect(t.seen[0]?.url).toBe('http://privacy.test/de-pseudonymize');
    expect(t.seen[0]?.actor).toBe('fake-actor-token');
  });

  it('M4-07 NFR-12 TK-21 a 503 is asked once and never again: a second call would be a second use of the approval', async () => {
    const t = setup(() => json(503, {}));
    await expect(client(t).open(request, actor)).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
    expect(t.count()).toBe(1);
  });

  it.each([
    ['DISCLOSURE_NOT_FOUND', 404],
    ['DISCLOSURE_NOT_APPROVED', 403],
    ['DISCLOSURE_EXPIRED', 410],
    ['REQUESTER_MISMATCH', 403],
  ])(
    'M4-07 TK-21 the refusal %s of Privacy is thrown with its own reason',
    async (reason, status) => {
      const t = setup(() => json(status, { error: { code: 'ACCESS_DENIED', reason } }));
      await expect(client(t).open(request, actor)).rejects.toMatchObject({ reason });
      expect(t.count()).toBe(1);
    },
  );

  it.each([
    ['an attribute of another name', { attributes: { nama: 'x', hp: '081200000052' } }],
    ['an attribute that is not text', { attributes: { nik: 12345 } }],
    ['an answer with no attributes object', { mapping_id: 'x' }],
    ['attributes as a list', { attributes: ['nama'] }],
  ])('M4-07 T-14 %s is SERVICE_UNAVAILABLE and nothing is returned', async (_label, body) => {
    await expect(client(setup(() => json(200, body))).open(request, actor)).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
  });
});
