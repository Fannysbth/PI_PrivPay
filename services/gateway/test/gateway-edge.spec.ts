import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { HOSTS, startGateway, type Harness } from './harness';

// DK-02b: with EDGE_TOKENIZATION=true the identifiers are replaced by Kong before the adapter, and the adapter accepts
// only that tokenized shape from Kong (X-Edge-Auth), never raw identifiers. Everything else of the adapter is as before:
// it still proves the caller, the role and the shapes, so a client that went round Kong gets nothing through.
const person = buildCanary(52);
const KEY = ['3f2b8c1e', '6a4d', '4e7b', '9c1a', '0d5e7f9a1b2c'].join('-');
const SECRET = 'fake-edge-secret-0123456789abcdefghijklmnop';
const raw = {
  source_account: person.rekening,
  merchant_id: 'MRC-001',
  amount: 150000,
  geohash: 'qqguy',
};
const tokenized = {
  transaction_id: 'TX-1760000000000001',
  idempotency_key: KEY,
  customer_token: 'PSEU-AAAA0001',
  account_token: 'PSEU-BBBB0002',
  merchant_id: 'MRC-001',
  amount: 150000,
  geohash: 'qqguy',
};

let gateway: Harness;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-edge-'));
  const secretFile = join(dir, 'edge_adapter_secret');
  writeFileSync(secretFile, `${SECRET}\n`);
  gateway = await startGateway({
    EDGE_TOKENIZATION: 'true',
    EDGE_ADAPTER_SECRET_FILE: secretFile,
  });
  gateway.network.respond(HOSTS['transaction-service'], () => ({
    status: 201,
    body: { transaction_id: tokenized.transaction_id, status: 'PENDING' },
  }));
  gateway.network.respond(HOSTS['reconciliation-service'], () => ({
    status: 202,
    body: { accepted: true },
  }));
  gateway.network.respond(HOSTS['notification-service'], () => ({
    status: 200,
    body: { status: 'REGISTERED', notification_domain_id: 'PSEU-DDDD0004' },
  }));
});
afterEach(async () => {
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
});

const server = () => request(gateway.app.httpServer);
const pay = (token: string, payload: object, edge: string | null = SECRET) => {
  const call = server()
    .post('/transaction')
    .set('authorization', `Bearer ${token}`)
    .set('idempotency-key', KEY)
    .send(payload);
  if (edge !== null) void call.set('x-edge-auth', edge);
  return call;
};
const downstream = () => gateway.network.requests.filter((call) => call.host !== HOSTS.idp);
const reached = (host: keyof typeof HOSTS) => gateway.network.to(HOSTS[host]);

describe('DK-02b adapter behind Kong: the tokenized request of Kong is forwarded as it is', () => {
  it('DK-02b AZ-03 a payment tokenized by Kong goes to Transaction unchanged, and Privacy is not asked again', async () => {
    const answer = await pay(gateway.tokens.customer(), tokenized);
    expect(answer.status).toBe(201);
    expect(reached('transaction-service')).toHaveLength(1);
    expect(reached('transaction-service')[0]?.body).toEqual(tokenized);
    expect(reached('privacy-service')).toHaveLength(0);
  });

  it('DK-02b AZ-09 a settlement report tokenized by Kong goes to Reconciliation', async () => {
    const report = {
      batch_date: '2026-10-18',
      items: [{ account_pseudonym: 'PSEU-CCCC0003', amount: 1500, bank_reference: 'BANK-REF-1' }],
    };
    const answer = await server()
      .post('/settlement/report')
      .set('authorization', `Bearer ${gateway.tokens.bank()}`)
      .set('x-edge-auth', SECRET)
      .send(report);
    expect(answer.status).toBeLessThan(300);
    expect(reached('reconciliation-service')[0]?.body).toEqual(report);
    expect(reached('privacy-service')).toHaveLength(0);
  });

  it('DK-02b AZ-02 a phone change tokenized by Kong goes to Notification, and the client sees only the status', async () => {
    const answer = await server()
      .post('/notification/register')
      .set('authorization', `Bearer ${gateway.tokens.customer()}`)
      .set('x-edge-auth', SECRET)
      .send({ notification_domain_id: 'PSEU-DDDD0004', phone: '081234567890', channel: 'SMS' });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'REGISTERED' });
    expect(reached('privacy-service')).toHaveLength(0);
  });
});

describe('DK-02b adapter behind Kong: nothing raw goes on, ever (invariant 8)', () => {
  it('DK-02b a valid raw payment without the secret of Kong is 503 and nothing goes downstream', async () => {
    const answer = await pay(gateway.tokens.customer(), raw, null);
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(downstream()).toHaveLength(0);
  });

  it('DK-02b a wrong secret is the same as none', async () => {
    const answer = await pay(gateway.tokens.customer(), raw, `${SECRET}x`);
    expect(answer.status).toBe(503);
    expect(downstream()).toHaveLength(0);
  });

  it('DK-02b a tokenized-looking body without the secret of Kong is refused (a client cannot name a token)', async () => {
    const answer = await pay(gateway.tokens.customer(), tokenized, null);
    expect(answer.status).toBe(422);
    expect(downstream()).toHaveLength(0);
  });

  it('DK-02b with the secret, a body that still carries a raw account number is 422 and nothing goes downstream', async () => {
    const answer = await pay(gateway.tokens.customer(), {
      ...tokenized,
      account_token: person.rekening,
    });
    expect(answer.status).toBe(422);
    expect(downstream()).toHaveLength(0);
  });

  it('DK-02b with the secret, an extra field (a customer_id) is 422', async () => {
    const answer = await pay(gateway.tokens.customer(), {
      ...tokenized,
      customer_id: person.customer_id,
    });
    expect(answer.status).toBe(422);
    expect(downstream()).toHaveLength(0);
  });
});

describe('DK-02b adapter behind Kong: it still proves the caller and the shape itself', () => {
  it('DK-02b AZ-03 a person, the bank and a service are 403 even with the secret of Kong', async () => {
    for (const token of [
      gateway.tokens.person('admin'),
      gateway.tokens.bank(),
      gateway.tokens.service('transaction', ['api-gateway']),
    ]) {
      expect((await pay(token, tokenized)).status).toBe(403);
    }
    expect(downstream()).toHaveLength(0);
  });

  it('DK-02b an invalid raw payment is 422 as before, not 503', async () => {
    const answer = await pay(gateway.tokens.customer(), { ...raw, amount: -1 }, null);
    expect(answer.status).toBe(422);
    expect(downstream()).toHaveLength(0);
  });

  it('DK-02b a payment without a valid Idempotency-Key is 422 as before', async () => {
    const answer = await server()
      .post('/transaction')
      .set('authorization', `Bearer ${gateway.tokens.customer()}`)
      .send(raw);
    expect(answer.status).toBe(422);
    expect(downstream()).toHaveLength(0);
  });
});

describe('DK-02b the edge settings are validated at start-up', () => {
  it('DK-02b EDGE_TOKENIZATION=true needs the secret file and the proposed condition', async () => {
    await expect(startGateway({ EDGE_TOKENIZATION: 'true' })).rejects.toThrow(
      /EDGE_ADAPTER_SECRET/,
    );
    const secretFile = join(dir, 'edge_adapter_secret');
    await expect(
      startGateway({
        EDGE_TOKENIZATION: 'true',
        EDGE_ADAPTER_SECRET_FILE: secretFile,
        PRIVACY_MODE: 'baseline',
        PRIVACY_SERVICE_URL: undefined,
      }),
    ).rejects.toThrow(/EDGE_TOKENIZATION/);
  });
});
