import { DomainError, FakeClock, type HttpClient, type HttpRequest } from '@privpay/common';
import { ErrorMasker } from '../src/error-masker';
import { HttpPrivacyPort } from '../src/tokenizer/http-privacy-port';
import { TransactionIdGenerator } from '../src/tokenizer/transaction-id';

const TX = /^TX-[0-9]{1,29}$/;

describe('M2-11 K-17 TransactionIdGenerator', () => {
  it('M2-11 K-17 TX- then 13 digits of epoch milliseconds and a 3-digit counter', () => {
    const clock = new FakeClock('2026-10-20T08:00:00.000Z');
    const next = new TransactionIdGenerator(clock);
    expect(next.generate()).toBe(`TX-${String(clock.now().getTime())}000`);
    expect(next.generate()).toBe(`TX-${String(clock.now().getTime())}001`);
  });

  it('M2-11 K-17 a thousand ids in one millisecond are all different and all match TransactionId', () => {
    const next = new TransactionIdGenerator(new FakeClock('2026-10-20T08:00:00.000Z'));
    const ids = Array.from({ length: 1000 }, () => next.generate());
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) expect(id).toMatch(TX);
  });

  it('M2-11 K-17 the counter wraps after 999 and a later millisecond gives a new id', () => {
    const clock = new FakeClock('2026-10-20T08:00:00.000Z');
    const next = new TransactionIdGenerator(clock);
    for (let n = 0; n < 1000; n += 1) next.generate();
    clock.advance(0.001);
    expect(next.generate()).toMatch(/000$/);
  });
});

interface FakeHttp extends HttpClient {
  /** What the port sent: set by the last call. */
  sent: HttpRequest | undefined;
}
function client(answer: { status: number; body?: unknown } | Error): FakeHttp {
  const fake: FakeHttp = {
    sent: undefined,
    request: (request: HttpRequest) => {
      fake.sent = request;
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ status: answer.status, body: answer.body });
    },
  };
  return fake;
}
const ask = {
  subjectType: 'CUSTOMER',
  subjectId: 'CUST-900001',
  targetService: 'TRANSACTION',
  purpose: 'PAYMENT_PROCESSING',
  transactionId: 'TX-1',
} as const;

function port(http: HttpClient) {
  return new HttpPrivacyPort({
    http,
    masker: new ErrorMasker(),
    serviceToken: { get: () => Promise.resolve('fake-gateway-service-token') },
  });
}

describe('M2-11 HttpPrivacyPort', () => {
  it('M2-11 FR-02 posts form 1 with the gateway service token, as an idempotent call', async () => {
    const http = client({
      status: 200,
      body: { pseudonym: 'PSEU-0A1B2C3D', expires_at: 'x', reused: false },
    });
    expect(await port(http).pseudonymize(ask)).toBe('PSEU-0A1B2C3D');
    expect(http.sent).toMatchObject({
      service: 'privacy-service',
      method: 'POST',
      path: '/pseudonymize',
      idempotent: true,
      authorization: 'Bearer fake-gateway-service-token',
      body: {
        subject_type: 'CUSTOMER',
        subject_id: 'CUST-900001',
        target_service: 'TRANSACTION',
        purpose: 'PAYMENT_PROCESSING',
        transaction_id: 'TX-1',
      },
    });
  });

  it('M2-11 NFR-11 a call without a transaction id leaves the field out', async () => {
    const http = client({ status: 200, body: { pseudonym: 'PSEU-0A1B2C3D' } });
    await port(http).pseudonymize({ ...ask, transactionId: undefined });
    expect(http.sent?.body).not.toHaveProperty('transaction_id');
  });

  it.each([500, 502, 504])(
    'M2-11 FR-38 a %i from Privacy is SERVICE_UNAVAILABLE',
    async (status) => {
      await expect(port(client({ status })).pseudonymize(ask)).rejects.toMatchObject({
        reason: 'SERVICE_UNAVAILABLE',
      });
    },
  );

  it('M2-11 FR-38 an unreachable Privacy (the client gave up) is SERVICE_UNAVAILABLE', async () => {
    const down = new DomainError('SERVICE_UNAVAILABLE', 'timeout');
    await expect(port(client(down)).pseudonymize(ask)).rejects.toBe(down);
  });

  it('M2-11 FR-38 a refusal keeps its reason (the masker makes it ACCESS_DENIED for the client)', async () => {
    const http = client({ status: 403, body: { error: { reason: 'POLICY_NOT_ALLOWED' } } });
    await expect(port(http).pseudonymize(ask)).rejects.toMatchObject({
      reason: 'POLICY_NOT_ALLOWED',
    });
  });

  it('M2-11 an answer that is not a pseudonym is a fault, never a value to forward', async () => {
    for (const body of [undefined, {}, { pseudonym: 'CUST-900001' }, { pseudonym: 5 }]) {
      await expect(port(client({ status: 200, body })).pseudonymize(ask)).rejects.toMatchObject({
        reason: 'SERVICE_UNAVAILABLE',
      });
    }
  });
});

describe('ADR-0019 HttpPrivacyPort.pseudonymizeBatch', () => {
  const pair = [ask, { ...ask, subjectType: 'ACCOUNT', subjectId: '90000000001' }] as const;
  const answers = {
    items: [
      { pseudonym: 'PSEU-0A1B2C3D', expires_at: 'x', reused: false },
      { pseudonym: 'PSEU-4E5F6071', expires_at: 'x', reused: false },
    ],
  };

  it('ADR-0019 posts both elements in one idempotent call and returns the tokens in the order asked', async () => {
    const http = client({ status: 200, body: answers });
    expect(await port(http).pseudonymizeBatch(pair)).toEqual(['PSEU-0A1B2C3D', 'PSEU-4E5F6071']);
    expect(http.sent).toMatchObject({
      service: 'privacy-service',
      method: 'POST',
      path: '/pseudonymize/batch',
      idempotent: true,
      authorization: 'Bearer fake-gateway-service-token',
      body: {
        requests: [
          { subject_type: 'CUSTOMER', subject_id: 'CUST-900001', transaction_id: 'TX-1' },
          { subject_type: 'ACCOUNT', subject_id: '90000000001', transaction_id: 'TX-1' },
        ],
      },
    });
    // Nothing but the list: the caller is named by the token, never by the body (D-16).
    expect(Object.keys(http.sent?.body as object)).toEqual(['requests']);
  });

  it.each([500, 502, 504])(
    'ADR-0019 TK-16 a %i from Privacy is SERVICE_UNAVAILABLE',
    async (status) => {
      await expect(port(client({ status })).pseudonymizeBatch(pair)).rejects.toMatchObject({
        reason: 'SERVICE_UNAVAILABLE',
      });
    },
  );

  it('ADR-0019 TK-16 an unreachable Privacy (the client gave up) is SERVICE_UNAVAILABLE', async () => {
    const down = new DomainError('SERVICE_UNAVAILABLE', 'timeout');
    await expect(port(client(down)).pseudonymizeBatch(pair)).rejects.toBe(down);
  });

  it('ADR-0019 a refusal keeps its reason, and no token of the batch is used', async () => {
    const http = client({ status: 403, body: { error: { reason: 'POLICY_NOT_ALLOWED' } } });
    await expect(port(http).pseudonymizeBatch(pair)).rejects.toMatchObject({
      reason: 'POLICY_NOT_ALLOWED',
    });
  });

  it('ADR-0019 an answer with the wrong number of items, or one that is not a pseudonym, is a fault', async () => {
    const [first] = answers.items;
    const bodies = [
      undefined,
      {},
      { items: [] },
      { items: [first] },
      { items: [...answers.items, first] },
      { items: [first, { pseudonym: 'CUST-900001' }] },
      { items: [first, { pseudonym: 5 }] },
    ];
    for (const body of bodies) {
      await expect(
        port(client({ status: 200, body })).pseudonymizeBatch(pair),
      ).rejects.toMatchObject({
        reason: 'SERVICE_UNAVAILABLE',
      });
    }
  });
});
