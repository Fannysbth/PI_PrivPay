import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { HOSTS, startGateway, type Harness, type Recorded } from './harness';

// Seam: the gateway over HTTP with fake hosts for the IdP, Privacy, Transaction and Reconciliation. The customer is
// CUST-000101 of the harness token; the other values are the generated canaries.
const person = buildCanary(51);
const KEY = ['3f2b8c1e', '6a4d', '4e7b', '9c1a', '0d5e7f9a1b2c'].join('-');
const body = {
  source_account: person.rekening,
  merchant_id: 'MRC-001',
  amount: 150000,
  geohash: 'qqguy',
  nik: person.nik,
  nama: person.nama,
  email: person.email,
};

let gateway: Harness;
let issued: number;
let pseudonyms: Map<string, string>;

beforeEach(async () => {
  gateway = await startGateway();
  issued = 0;
  pseudonyms = new Map();
  gateway.network.respond(HOSTS['privacy-service'], (call: Recorded) => {
    const ask = call.body as Record<string, string>;
    const key = [
      ask['subject_type'],
      ask['subject_id'],
      ask['target_service'],
      ask['purpose'],
    ].join('|');
    let pseudonym = pseudonyms.get(key);
    if (pseudonym === undefined) {
      issued += 1;
      pseudonym = `PSEU-${issued.toString(16).toUpperCase().padStart(8, '0')}`;
      pseudonyms.set(key, pseudonym);
    }
    return {
      status: 200,
      body: { pseudonym, expires_at: '2026-10-19T08:15:00.000Z', reused: false },
    };
  });
  gateway.network.respond(HOSTS['transaction-service'], (call: Recorded) => ({
    status: 201,
    body: {
      transaction_id: (call.body as { transaction_id: string }).transaction_id,
      status: 'PENDING',
    },
  }));
  gateway.network.respond(HOSTS['reconciliation-service'], () => ({
    status: 202,
    body: { accepted: true },
  }));
});
afterEach(async () => {
  await gateway.close();
});

const server = () => request(gateway.app.httpServer);
const pay = (token: string | undefined, payload: object = body, key: string | null = KEY) => {
  const call = server().post('/transaction').send(payload);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  if (key !== null) void call.set('idempotency-key', key);
  return call;
};
const hostCalls = (host: keyof typeof HOSTS) => gateway.network.to(HOSTS[host]);
const downstream = () => gateway.network.requests.filter((call) => call.host !== HOSTS.idp).length;
const privacyCalls = () => hostCalls('privacy-service');

describe('M2-11 AZ-03 POST /transaction', () => {
  it('M2-11 FR-02 FR-03 AZ-03 a customer pays: Privacy gets the raw ids, Transaction gets tokens only', async () => {
    const answer = await pay(gateway.tokens.customer());
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ status: 'PENDING' });
    expect((answer.body as { transaction_id: string }).transaction_id).toMatch(/^TX-[0-9]{16}$/);

    const [toTransaction] = hostCalls('transaction-service');
    expect(toTransaction?.path).toBe('/transaction');
    const outbound = toTransaction?.body as Record<string, unknown>;
    expect(Object.keys(outbound).sort()).toEqual(
      [
        'account_token',
        'amount',
        'customer_token',
        'geohash',
        'idempotency_key',
        'merchant_id',
        'transaction_id',
      ].sort(),
    );
    expect(outbound['idempotency_key']).toBe(KEY);
    expect(outbound['customer_token']).toMatch(/^PSEU-[0-9A-F]{8}$/);
    // The customer id comes from the token (CUST-000101 of the harness), the account from the body.
    const subjects = privacyCalls().map(
      (call) => (call.body as Record<string, string>)['subject_id'],
    );
    expect(subjects.sort()).toEqual(['CUST-000101', person.rekening].sort());
    for (const call of privacyCalls()) {
      expect(call.path).toBe('/pseudonymize');
      expect(call.headers['x-actor-token']).toBeUndefined();
      expect((call.body as Record<string, string>)['transaction_id']).toBe(
        outbound['transaction_id'],
      );
    }
    // Nothing the client sent that is personal is on the wire to Transaction, and no customer JWT either.
    assertNoFindings(
      scanText(JSON.stringify(toTransaction), [person], {
        service: 'transaction',
        location: 'wire',
      }),
    );
    expect(toTransaction?.headers['authorization']).not.toBe(`Bearer ${gateway.tokens.customer()}`);
    expect(toTransaction?.headers['x-actor-token']).toBeUndefined();
  });

  it('M2-11 K-17 every payment gets its own transaction id', async () => {
    const one = await pay(gateway.tokens.customer());
    const two = await pay(gateway.tokens.customer());
    expect((one.body as { transaction_id: string }).transaction_id).not.toBe(
      (two.body as { transaction_id: string }).transaction_id,
    );
  });

  it('M2-11 AZ-03 N1 no token, a forged one: 401 and nothing goes downstream', async () => {
    expect((await pay(undefined)).status).toBe(401);
    expect((await pay(gateway.tokens.foreign('admin'))).status).toBe(401);
    expect(downstream()).toBe(0);
  });

  it('M2-11 AZ-03 N2 a person, the bank and a service account are 403 and nothing goes downstream', async () => {
    for (const token of [
      gateway.tokens.person('fraud_analyst'),
      gateway.tokens.person('admin'),
      gateway.tokens.bank(),
      gateway.tokens.service('transaction', ['api-gateway']),
    ]) {
      expect((await pay(token)).status).toBe(403);
    }
    expect(downstream()).toBe(0);
  });

  it('M2-11 AZ-03 FR-09 no Idempotency-Key, or one that is not a UUID, is 422 and nothing goes downstream', async () => {
    expect((await pay(gateway.tokens.customer(), body, null)).status).toBe(422);
    expect((await pay(gateway.tokens.customer(), body, 'not-a-uuid')).status).toBe(422);
    expect(downstream()).toBe(0);
  });

  it('M2-11 AZ-03 N3 N4 a field nobody declared (also customer_id or requesting_service) is 422', async () => {
    for (const extra of [
      { surprise: 1 },
      { customer_id: 'CUST-000999' },
      { requesting_service: 'API_GATEWAY' },
    ]) {
      expect((await pay(gateway.tokens.customer(), { ...body, ...extra })).status).toBe(422);
    }
    expect((await pay(gateway.tokens.customer(), { ...body, amount: 0 })).status).toBe(422);
    expect(downstream()).toBe(0);
  });

  it('M2-11 FR-03 the client may send nik, nama and email: they are accepted and dropped', async () => {
    const plain = Object.fromEntries(
      Object.entries(body).filter(([name]) => !['nik', 'nama', 'email'].includes(name)),
    );
    expect((await pay(gateway.tokens.customer(), plain)).status).toBe(201);
    expect((await pay(gateway.tokens.customer(), body)).status).toBe(201);
  });
});

describe('M2-11 fail closed (invariant 8, FR-38, NFR-11, TK-16)', () => {
  it('M2-11 TK-16 Privacy down: 503 and Transaction is never called', async () => {
    gateway.network.respond(HOSTS['privacy-service'], () => 'network-error');
    const answer = await pay(gateway.tokens.customer());
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(hostCalls('transaction-service')).toHaveLength(0);
  });

  it('M2-11 TK-16 Privacy answering 500 or 503 is 503 and Transaction is never called', async () => {
    for (const status of [500, 503]) {
      gateway.network.respond(HOSTS['privacy-service'], () => ({
        status,
        body: { error: { reason: 'INTERNAL_ERROR' } },
      }));
      expect((await pay(gateway.tokens.customer())).status).toBe(503);
    }
    expect(hostCalls('transaction-service')).toHaveLength(0);
  });

  it('M2-11 FR-38 Privacy refusing is 403 ACCESS_DENIED and the reason is not told', async () => {
    gateway.network.respond(HOSTS['privacy-service'], () => ({
      status: 403,
      body: { error: { reason: 'POLICY_NOT_ALLOWED' } },
    }));
    const answer = await pay(gateway.tokens.customer());
    expect(answer.status).toBe(403);
    expect(JSON.stringify(answer.body)).not.toContain('POLICY_NOT_ALLOWED');
    expect(hostCalls('transaction-service')).toHaveLength(0);
  });

  it('M2-11 NFR-11 Transaction down after the tokens: 503', async () => {
    gateway.network.respond(HOSTS['transaction-service'], () => 'network-error');
    expect((await pay(gateway.tokens.customer())).status).toBe(503);
  });

  it('M2-11 invariant 6 after payments, failures and refusals the log holds none of the canaries', async () => {
    await pay(gateway.tokens.customer());
    gateway.network.respond(HOSTS['privacy-service'], () => 'network-error');
    await pay(gateway.tokens.customer());
    await pay(gateway.tokens.person('admin'));
    assertNoFindings(
      scanText(gateway.logLines.join('\n'), [person], { service: 'gateway', location: 'log' }),
    );
    expect(gateway.logLines.join('\n')).not.toContain('CUST-000101');
  });
});

const settlement = (items: object[], date = '2026-10-18') => ({ batch_date: date, items });
const entry = (n: number) => ({
  account_number: buildCanary(n).rekening,
  amount: 1000 + n,
  bank_reference: `BANK-REF-${String(n)}`,
});
const report = (token: string | undefined, payload: object) => {
  const call = server().post('/settlement/report').send(payload);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};

describe('M2-11 AZ-09 POST /settlement/report', () => {
  it('M2-11 FR-32 AZ-09 the bank reports: Reconciliation gets tokens, the same as the D2 flow would give', async () => {
    const answer = await report(gateway.tokens.bank(), settlement([entry(1), entry(2)]));
    expect(answer.status).toBe(202);
    const [toReconciliation] = hostCalls('reconciliation-service');
    expect(toReconciliation?.path).toBe('/reconciliation/settlement-report');
    const outbound = toReconciliation?.body as { items: { account_pseudonym: string }[] };
    expect(outbound.items).toHaveLength(2);
    assertNoFindings(
      scanText(JSON.stringify(toReconciliation), [buildCanary(1), buildCanary(2)], {
        service: 'reconciliation',
        location: 'wire',
      }),
    );
    for (const call of privacyCalls()) {
      expect(call.body).toMatchObject({
        subject_type: 'ACCOUNT',
        target_service: 'RECONCILIATION',
        purpose: 'DAILY_RECONCILIATION',
      });
      expect(call.body).not.toHaveProperty('transaction_id');
    }
  });

  it('M2-11 AZ-09 N1 N2 no token is 401; a customer, a person and a service are 403; nothing goes downstream', async () => {
    expect((await report(undefined, settlement([entry(1)]))).status).toBe(401);
    for (const token of [
      gateway.tokens.customer(),
      gateway.tokens.person('admin'),
      gateway.tokens.service('reconciliation', ['api-gateway']),
    ]) {
      expect((await report(token, settlement([entry(1)]))).status).toBe(403);
    }
    expect(downstream()).toBe(0);
  });

  it('M2-11 TF-13 AZ-09 N3 one bad item or an unknown field is 422, no token is asked for', async () => {
    const bad = { ...entry(3), account_number: 'abc' };
    expect(
      (await report(gateway.tokens.bank(), settlement([entry(1), entry(2), bad]))).status,
    ).toBe(422);
    expect(
      (await report(gateway.tokens.bank(), { ...settlement([entry(1)]), extra: 1 })).status,
    ).toBe(422);
    expect(downstream()).toBe(0);
  });

  it('M2-11 N-27 the largest report (500 worst-case items) fits the 64 KiB limit; 501 items is 422', async () => {
    const worst = (n: number): object => ({
      account_number: String(10 ** 19 + n),
      amount: Number.MAX_SAFE_INTEGER,
      bank_reference: 'R'.repeat(32),
    });
    const full = settlement(Array.from({ length: 500 }, (_, n) => worst(n)));
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(64 * 1024);
    expect((await report(gateway.tokens.bank(), full)).status).toBe(202);
    const over = settlement(Array.from({ length: 501 }, (_, n) => worst(n)));
    expect((await report(gateway.tokens.bank(), over)).status).toBe(422);
  });

  it('M2-11 K-12 a report over 64 KiB is 422 and nothing goes downstream', async () => {
    // Small once parsed, large on the wire: the declared length is what the route limit is checked against.
    const padded = await server()
      .post('/settlement/report')
      .set('authorization', `Bearer ${gateway.tokens.bank()}`)
      .type('json')
      .send(`${JSON.stringify(settlement([entry(1)]))}${' '.repeat(70_000)}`);
    expect(padded.status).toBe(422);
    expect(downstream()).toBe(0);
  });

  it('M2-11 NFR-11 Privacy down: 503 and Reconciliation is never called', async () => {
    gateway.network.respond(HOSTS['privacy-service'], () => 'network-error');
    expect((await report(gateway.tokens.bank(), settlement([entry(1)]))).status).toBe(503);
    expect(hostCalls('reconciliation-service')).toHaveLength(0);
  });
});
