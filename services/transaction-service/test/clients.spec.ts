import { createHttpClient, FakeDelay, type HttpClient } from '@privpay/common';
import {
  HttpFraudClient,
  HttpNotificationClient,
  HttpPrivacyClient,
  ProposedSubjectReferences,
} from '../src/transaction/clients';
import { PrivacyRejectedError, TokenExpiredError } from '../src/transaction';

// Seam: the HTTP adapters towards Privacy, Fraud and Notification, through the shared client with a stub for fetch.
// NFR-12: only an idempotent call may be sent twice. The stub counts what actually reaches the neighbour.
const TOKEN = { get: () => Promise.resolve('fake-service-token') };
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Behaviour = (call: number, signal: AbortSignal) => Promise<Response>;

function setup(behaviour: Behaviour) {
  let calls = 0;
  const urls: string[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    calls += 1;
    urls.push(typeof input === 'string' ? input : 'request');
    return behaviour(calls, init?.signal ?? new AbortController().signal);
  };
  const http: HttpClient = createHttpClient({
    baseUrls: {
      'privacy-service': 'http://privacy.test',
      'fraud-service': 'http://fraud.test',
      'notification-service': 'http://notification.test',
    },
    timeoutMs: 3000,
    maxRetries: 2,
    delay: new FakeDelay(),
    fetch: fetchStub,
    // The slow neighbour: the time is up at once, without waiting for real time.
    timeoutSignal: () => AbortSignal.abort(),
  });
  const deps = { http, serviceToken: TOKEN };
  return { deps, count: () => calls, urls };
}

const slow: Behaviour = (_call, signal) =>
  new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
const unavailable: Behaviour = () => Promise.resolve(json(503, {}));
const network: Behaviour = () => Promise.reject(new Error('refused'));

const fraudRequest = { subject: 'PSEU-F0000001', amount: 2_000_000, txHour: 9, geohash: 'qqgu4' };
const sendRequest = {
  subject: 'PSEU-A0000001',
  template: 'TX_COMPLETED',
  amount: 35000,
  transactionId: 'TX-2001',
} as const;

describe('M4-02 NFR-12 the calls that are not idempotent are made exactly once', () => {
  it.each([
    ['slow', slow],
    ['unavailable (503)', unavailable],
    ['a network failure', network],
  ])('M4-02 NFR-12 POST /fraud/assess is one call when Fraud is %s', async (_name, behaviour) => {
    const { deps, count } = setup(behaviour);
    await expect(new HttpFraudClient(deps).assess(fraudRequest)).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
    expect(count()).toBe(1);
  });

  it.each([
    ['slow', slow],
    ['unavailable (503)', unavailable],
    ['a network failure', network],
  ])(
    'M4-02 NFR-12 POST /notification/send is one call when Notification is %s',
    async (_name, behaviour) => {
      const { deps, count } = setup(behaviour);
      await expect(new HttpNotificationClient(deps).send(sendRequest)).rejects.toMatchObject({
        reason: 'SERVICE_UNAVAILABLE',
      });
      expect(count()).toBe(1);
    },
  );

  it.each([
    [
      'PATCH /transaction-status',
      (d: ReturnType<typeof setup>['deps']) =>
        new HttpPrivacyClient(d).patchStatus('TX-2001', 'COMPLETED'),
    ],
    [
      'POST /pseudonymize (exchange)',
      (d: ReturnType<typeof setup>['deps']) =>
        new HttpPrivacyClient(d).exchange({
          sourcePseudonym: 'PSEU-00000001',
          targetService: 'FRAUD',
          purpose: 'FRAUD_DETECTION',
          transactionId: 'TX-2001',
        }),
    ],
    [
      'POST /re-issue',
      (d: ReturnType<typeof setup>['deps']) =>
        new HttpPrivacyClient(d).reIssue('PSEU-00000001', 'TX-2001'),
    ],
  ])(
    'M4-02 NFR-12 contrast: %s is idempotent and does get its two retries',
    async (_name, call) => {
      const { deps, count } = setup(unavailable);
      await expect(call(deps)).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
      expect(count()).toBe(3);
    },
  );
});

describe('M4-02 FR-10 the proposed adapter of the port', () => {
  it('M4-02 TF-04 an EXPIRED answer of the exchange is TokenExpiredError, and any other refusal is not', async () => {
    const expired = setup(() => Promise.resolve(json(410, { error: { reason: 'EXPIRED' } })));
    const subjects = new ProposedSubjectReferences(new HttpPrivacyClient(expired.deps));
    const row = {
      transactionId: 'TX-2001',
      customerToken: 'PSEU-00000001',
      accountToken: 'PSEU-00000002',
    };
    await expect(subjects.forFraud(row)).rejects.toBeInstanceOf(TokenExpiredError);
    expect(expired.count()).toBe(1);

    const revoked = setup(() => Promise.resolve(json(403, { error: { reason: 'REVOKED' } })));
    const refused = new ProposedSubjectReferences(new HttpPrivacyClient(revoked.deps));
    await expect(refused.forNotification(row)).rejects.not.toBeInstanceOf(TokenExpiredError);
  });

  it('M4-02 FR-10 asks Privacy for the customer token only, with the transaction id and the target of Tabel 2', async () => {
    let body: unknown;
    const spying = createHttpClient({
      baseUrls: { 'privacy-service': 'http://privacy.test' },
      timeoutMs: 3000,
      maxRetries: 2,
      fetch: (_input, init) => {
        body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        return Promise.resolve(json(200, { pseudonym: 'PSEU-F0000001' }));
      },
    });
    const subjects = new ProposedSubjectReferences(
      new HttpPrivacyClient({ http: spying, serviceToken: TOKEN }),
    );
    await subjects.forFraud({
      transactionId: 'TX-2001',
      customerToken: 'PSEU-00000001',
      accountToken: 'PSEU-00000002',
    });
    expect(body).toEqual({
      source_pseudonym: 'PSEU-00000001',
      target_service: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      transaction_id: 'TX-2001',
    });
  });
});

describe('N-40 which answers of Privacy to a status PATCH are final', () => {
  it.each([400, 404, 409, 422])(
    'N-40 a %i from Privacy is a rejection of this row, in one call',
    async (status) => {
      const { deps, count } = setup(() => Promise.resolve(json(status, { error: {} })));
      await expect(
        new HttpPrivacyClient(deps).patchStatus('TX-2001', 'COMPLETED'),
      ).rejects.toBeInstanceOf(PrivacyRejectedError);
      expect(count()).toBe(1);
    },
  );

  // Not about the row: the same answer would come for every row, so the rows must not be marked as refused.
  it.each([401, 403, 408, 429, 500, 503])(
    'N-40 a %i from Privacy is not final, the row is tried again later',
    async (status) => {
      const { deps } = setup(() => Promise.resolve(json(status, { error: {} })));
      const failure = new HttpPrivacyClient(deps).patchStatus('TX-2001', 'COMPLETED');
      await expect(failure).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
      await expect(failure).rejects.not.toBeInstanceOf(PrivacyRejectedError);
    },
  );
});
