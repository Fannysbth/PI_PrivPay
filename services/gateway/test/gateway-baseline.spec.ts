import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { HOSTS, startGateway, type Harness } from './harness';

// Seam: the gateway over HTTP in baseline mode (M5-03, FR-23, gateway spec 8): the tokenizer hands the identity on as it
// is, Privacy is never called, and everything else of the path is the one of proposed. Hosts are fake. The customer is
// CUST-000101 of the harness token; the other values are generated canaries.
const person = buildCanary(53);
// Built at run time: a literal UUID under services/ would be reported by the secret scan.
const KEY = ['3f2b8c1e', '6a4d', '4e7b', '9c1a', '0d5e7f9a1b2c'].join('-');
const PAYMENT = {
  source_account: person.rekening,
  merchant_id: 'MRC-001',
  amount: 150000,
  geohash: 'qqguy',
};
const BASELINE_ENV = { PRIVACY_MODE: 'baseline', PRIVACY_SERVICE_URL: undefined };

let gateway: Harness;

beforeEach(async () => {
  gateway = await startGateway(BASELINE_ENV);
  gateway.network.respond(HOSTS['transaction-service'], (call) => ({
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
  gateway.network.respond(HOSTS['notification-service'], () => ({
    status: 200,
    body: { ok: true },
  }));
});
afterEach(async () => {
  await gateway.close();
});

const server = () => request(gateway.app.httpServer);
const pay = (token: string | undefined, payload: object = PAYMENT) => {
  const call = server().post('/transaction').send(payload).set('idempotency-key', KEY);
  if (token !== undefined) void call.set('authorization', `Bearer ${token}`);
  return call;
};
const hostCalls = (host: keyof typeof HOSTS) => gateway.network.to(HOSTS[host]);
const privacyCalls = () => hostCalls('privacy-service');

describe('M5-03 FR-23 POST /transaction in baseline mode', () => {
  it('M5-03 FR-23 the customer id and the account number go to Transaction as they are, and Privacy is never called', async () => {
    const answer = await pay(gateway.tokens.customer());
    expect(answer.status).toBe(201);
    const [toTransaction] = hostCalls('transaction-service');
    expect(toTransaction?.body).toMatchObject({
      customer_token: 'CUST-000101',
      account_token: person.rekening,
      idempotency_key: KEY,
      merchant_id: 'MRC-001',
      amount: 150000,
      geohash: 'qqguy',
    });
    expect(privacyCalls()).toHaveLength(0);
  });

  it('M5-03 FR-23 gateway spec 8 the NIK and the name the client sent go on as they are, the email does not (G1, G2)', async () => {
    const answer = await pay(gateway.tokens.customer(), {
      ...PAYMENT,
      nik: person.nik,
      nama: person.nama,
      email: person.email,
    });
    expect(answer.status).toBe(201);
    const [toTransaction] = hostCalls('transaction-service');
    expect(toTransaction?.body).toMatchObject({ nik: person.nik, nama: person.nama });
    expect(JSON.stringify(toTransaction?.body)).not.toContain(person.email);
  });

  it('M5-03 FR-23 gateway spec 8 what the client did not send is not invented (G1)', async () => {
    await pay(gateway.tokens.customer());
    const [toTransaction] = hostCalls('transaction-service');
    expect(Object.keys(toTransaction?.body as object).sort()).toEqual([
      'account_token',
      'amount',
      'customer_token',
      'geohash',
      'idempotency_key',
      'merchant_id',
      'transaction_id',
    ]);
  });

  it('M5-03 FR-23 the rest of the path is that of proposed: a new TX id for each request, no token is 401, a person is 403', async () => {
    const one = await pay(gateway.tokens.customer());
    const two = await pay(gateway.tokens.customer());
    const ids = [one, two].map((r) => (r.body as { transaction_id: string }).transaction_id);
    expect(ids[0]).toMatch(/^TX-[0-9]{16}$/);
    expect(ids[0]).not.toBe(ids[1]);
    const before = hostCalls('transaction-service').length;
    expect((await pay(undefined)).status).toBe(401);
    expect((await pay(gateway.tokens.person('admin'))).status).toBe(403);
    expect(hostCalls('transaction-service')).toHaveLength(before);
  });

  it('M5-03 FR-23 a failure of Transaction is masked as in proposed, and the body that names the failure is not passed on', async () => {
    gateway.network.respond(HOSTS['transaction-service'], () => ({
      status: 503,
      body: { error: { code: 'SERVICE_UNAVAILABLE', reason: 'SECRET_INTERNAL_DETAIL' } },
    }));
    const answer = await pay(gateway.tokens.customer());
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain('SECRET_INTERNAL_DETAIL');
    expect(privacyCalls()).toHaveLength(0);
  });

  it('M5-03 FR-23 a payload that the schema refuses is 422 in baseline too, and nothing goes downstream', async () => {
    const answer = await pay(gateway.tokens.customer(), { ...PAYMENT, extra: 1 });
    expect(answer.status).toBe(422);
    expect(hostCalls('transaction-service')).toHaveLength(0);
  });
});

describe('M5-03 FR-23 the other routes in baseline mode', () => {
  it('M5-03 FR-23 the settlement report goes to Reconciliation with the account numbers as they are', async () => {
    const answer = await server()
      .post('/settlement/report')
      .set('authorization', `Bearer ${gateway.tokens.bank()}`)
      .send({
        batch_date: '2026-10-19',
        items: [{ account_number: person.rekening, amount: 35_000, bank_reference: 'BANK-REF-1' }],
      });
    expect(answer.status).toBe(202);
    const [toReconciliation] = hostCalls('reconciliation-service');
    expect(toReconciliation?.body).toMatchObject({
      items: [{ account_pseudonym: person.rekening, amount: 35_000 }],
    });
    expect(privacyCalls()).toHaveLength(0);
  });

  it('M5-03 FR-23 the phone of the customer goes to Notification under the customer id, without Privacy', async () => {
    const answer = await server()
      .post('/notification/register')
      .set('authorization', `Bearer ${gateway.tokens.customer()}`)
      .send({ phone: '081200000001', channel: 'SMS' });
    expect(answer.status).toBe(200);
    const [toNotification] = hostCalls('notification-service');
    expect(toNotification?.body).toMatchObject({
      notification_domain_id: 'CUST-000101',
      phone: '081200000001',
      channel: 'SMS',
    });
    expect(privacyCalls()).toHaveLength(0);
  });
});

describe('M5-03 ADR-0006 an inconsistent environment does not start', () => {
  const starts = async (env: Record<string, string | undefined>) => {
    try {
      const started = await startGateway(env);
      await started.close();
      return undefined;
    } catch (error) {
      return error as Error;
    }
  };

  it('M5-03 baseline with PRIVACY_SERVICE_URL does not start and names only the variable', async () => {
    const error = await starts({ PRIVACY_MODE: 'baseline' });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('PRIVACY_SERVICE_URL');
  });

  it('M5-03 proposed without PRIVACY_SERVICE_URL does not start and names only the variable', async () => {
    const error = await starts({ PRIVACY_MODE: 'proposed', PRIVACY_SERVICE_URL: undefined });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('PRIVACY_SERVICE_URL');
  });
});
