import {
  BoundedTtlCache,
  createHttpClient,
  FakeClock,
  FakeDelay,
  type HttpClient,
} from '@privpay/common';
import { HttpPrivacyClient } from '../src/transaction/clients';
import { TokenExpiredError } from '../src/transaction';
import { ProposedSubjectReferences } from '../src/proposed';

// ADR-0020 / ADR-0021: Transaction keeps the answer of an exchange (X1, X2) for at most T seconds, keyed by the source
// token, the target and the purpose, never by transaction_id: the same person's token is the same token for the next
// payment. Nothing here sleeps; the clock is injected.
const START = '2026-11-12T00:00:00Z';
const TOKEN = { get: () => Promise.resolve('fake-service-token') };
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const row = (over: Partial<{ customerSubjectRef: string; transactionId: string }> = {}) =>
  ({
    transactionId: over.transactionId ?? 'TX-3001',
    customerSubjectRef: over.customerSubjectRef ?? 'PSEU-AAAAAAAA',
    accountSubjectRef: 'PSEU-BBBBBBBB',
  }) as never;

function setup(options: { ttlSeconds?: number; maxEntries?: number } = {}) {
  const clock = new FakeClock(START);
  let calls = 0;
  const bodies: unknown[] = [];
  let answer: (call: number) => Response = (call) =>
    json(200, {
      pseudonym: `PSEU-0000000${String(call)}`,
      expires_at: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      reused: false,
    });
  const fetchStub: typeof fetch = (_input, init) => {
    calls += 1;
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    return Promise.resolve(answer(calls));
  };
  const http: HttpClient = createHttpClient({
    baseUrls: { 'privacy-service': 'http://privacy.test' },
    timeoutMs: 3000,
    maxRetries: 0,
    delay: new FakeDelay(),
    fetch: fetchStub,
  });
  const privacy = new HttpPrivacyClient({ http, serviceToken: TOKEN });
  const cache = new BoundedTtlCache<string>({
    clock,
    ttlSeconds: options.ttlSeconds ?? 5,
    maxEntries: options.maxEntries ?? 100,
  });
  const subjects = new ProposedSubjectReferences(privacy, { cache, clock });
  return {
    clock,
    subjects,
    bodies,
    calls: () => calls,
    respond: (fn: (call: number) => Response) => {
      answer = fn;
    },
  };
}

describe('ADR-0020 the exchange of Transaction is kept for T seconds', () => {
  it('ADR-0020 the next payment of the same person reuses X1 without asking Privacy', async () => {
    const t = setup();
    const first = await t.subjects.forFraud(row({ transactionId: 'TX-3001' }));
    const second = await t.subjects.forFraud(row({ transactionId: 'TX-3002' }));
    expect(second).toBe(first);
    expect(t.calls()).toBe(1);
  });

  it('ADR-0020 X1 and X2 are separate entries: another target is another question', async () => {
    const t = setup();
    const fraud = await t.subjects.forFraud(row());
    const notification = await t.subjects.forNotification(row());
    expect(t.calls()).toBe(2);
    expect(notification).not.toBe(fraud);
    expect(await t.subjects.forFraud(row({ transactionId: 'TX-3002' }))).toBe(fraud);
    expect(await t.subjects.forNotification(row({ transactionId: 'TX-3002' }))).toBe(notification);
    expect(t.calls()).toBe(2);
  });

  it('ADR-0020 a different source token is a different key (invariant 5: no join through one entry)', async () => {
    const t = setup();
    await t.subjects.forFraud(row({ customerSubjectRef: 'PSEU-AAAAAAAA' }));
    await t.subjects.forFraud(row({ customerSubjectRef: 'PSEU-CCCCCCCC' }));
    expect(t.calls()).toBe(2);
  });

  it('ADR-0021 after T seconds Privacy is asked again', async () => {
    const t = setup({ ttlSeconds: 5 });
    await t.subjects.forFraud(row());
    t.clock.advance(4.9);
    await t.subjects.forFraud(row());
    expect(t.calls()).toBe(1);
    t.clock.advance(0.2);
    await t.subjects.forFraud(row());
    expect(t.calls()).toBe(2);
  });

  it('ADR-0020 T = 0 is the old behaviour: every exchange goes to Privacy', async () => {
    const t = setup({ ttlSeconds: 0 });
    await t.subjects.forFraud(row());
    await t.subjects.forFraud(row());
    expect(t.calls()).toBe(2);
  });

  it('ADR-0020 an entry never outlives the exchanged token (min of T and its remaining life)', async () => {
    const t = setup({ ttlSeconds: 30 });
    t.respond(() =>
      json(200, {
        pseudonym: 'PSEU-0000000A',
        expires_at: new Date(t.clock.now().getTime() + 2000).toISOString(),
        reused: false,
      }),
    );
    await t.subjects.forFraud(row());
    t.clock.advance(2);
    await t.subjects.forFraud(row());
    expect(t.calls()).toBe(2);
  });

  it('ADR-0020 the question sent to Privacy is unchanged: source token, target, purpose, transaction id', async () => {
    const t = setup();
    await t.subjects.forFraud(row({ transactionId: 'TX-3001' }));
    expect(t.bodies[0]).toEqual({
      source_pseudonym: 'PSEU-AAAAAAAA',
      target_service: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      transaction_id: 'TX-3001',
    });
  });

  it('ADR-0021 TF-04 an EXPIRED answer is not stored and reaches the caller, so the re-issue path still works', async () => {
    const t = setup();
    t.respond(() => json(410, { error: { code: 'TOKEN_EXPIRED', reason: 'EXPIRED' } }));
    await expect(t.subjects.forFraud(row())).rejects.toBeInstanceOf(TokenExpiredError);
    await expect(t.subjects.forFraud(row())).rejects.toBeInstanceOf(TokenExpiredError);
    expect(t.calls()).toBe(2);
  });

  it('ADR-0021 a failure is not stored: the next call tries Privacy again', async () => {
    const t = setup();
    t.respond(() => json(503, {}));
    await expect(t.subjects.forFraud(row())).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
    t.respond(() =>
      json(200, {
        pseudonym: 'PSEU-0000000B',
        expires_at: new Date(t.clock.now().getTime() + 3_600_000).toISOString(),
        reused: false,
      }),
    );
    expect(await t.subjects.forFraud(row())).toBe('PSEU-0000000B');
    expect(t.calls()).toBe(2);
  });

  it('ADR-0021 TK-16 Privacy down: a cold cache fails closed at once, a warm one holds for T seconds and then fails closed again', async () => {
    const t = setup({ ttlSeconds: 5 });
    t.respond(() => json(503, {}));
    await expect(t.subjects.forFraud(row())).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });

    t.respond(() =>
      json(200, {
        pseudonym: 'PSEU-0000000C',
        expires_at: new Date(t.clock.now().getTime() + 3_600_000).toISOString(),
        reused: false,
      }),
    );
    expect(await t.subjects.forFraud(row())).toBe('PSEU-0000000C');

    t.respond(() => json(503, {}));
    t.clock.advance(4);
    expect(await t.subjects.forFraud(row({ transactionId: 'TX-3002' }))).toBe('PSEU-0000000C');
    t.clock.advance(1.1);
    await expect(t.subjects.forFraud(row({ transactionId: 'TX-3003' }))).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
  });

  it('ADR-0020 the answer without a usable expiry is used but not stored (fail safe)', async () => {
    const t = setup();
    t.respond(() => json(200, { pseudonym: 'PSEU-0000000D', reused: false }));
    await t.subjects.forFraud(row());
    await t.subjects.forFraud(row());
    expect(t.calls()).toBe(2);
  });

  it('ADR-0020 an expires_at that is not a date is ignored, not a fault: the exchange still works, nothing is stored', async () => {
    const t = setup();
    t.respond(() =>
      json(200, { pseudonym: 'PSEU-0000000E', expires_at: 'tomorrow', reused: false }),
    );
    expect(await t.subjects.forFraud(row())).toBe('PSEU-0000000E');
    expect(await t.subjects.forFraud(row())).toBe('PSEU-0000000E');
    expect(t.calls()).toBe(2);
  });
});
