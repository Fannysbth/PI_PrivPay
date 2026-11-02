import request from 'supertest';
import { startGateway, type Harness } from './harness';

// ADR-0018: the one batch route (POST /reconciliation/run, an admin operation) waits for its downstream longer than the
// 3 s of NFR-12; every other route keeps 3 s. The seam is the timeout the HTTP client is given for each call, read through
// the Gateway (a fake timer, so no test waits for it). The IdP calls (token, JWKS) always use the 3 s.
describe('ADR-0018 batch route timeout', () => {
  let gateway: Harness | undefined;
  const timeouts: number[] = [];
  const spy = (ms: number): AbortSignal => {
    timeouts.push(ms);
    return new AbortController().signal;
  };
  const start = async (env: Record<string, string> = {}): Promise<Harness> => {
    gateway = await startGateway(env, { timeoutSignal: spy });
    return gateway;
  };
  // Whatever differs from the 3 s default is a route that was given its own timeout.
  const longer = (): number[] => timeouts.filter((ms) => ms !== 3000);

  afterEach(async () => {
    timeouts.length = 0;
    await gateway?.close();
    gateway = undefined;
  });

  it('ADR-0018 POST /reconciliation/run is given BATCH_HTTP_TIMEOUT_MS, once', async () => {
    const h = await start({ BATCH_HTTP_TIMEOUT_MS: '45000' });
    const response = await request(h.app.httpServer)
      .post('/reconciliation/run')
      .set('Authorization', `Bearer ${h.tokens.person('admin')}`)
      .send({ date: '2026-10-18' });
    expect(response.status).toBe(200);
    expect(longer()).toEqual([45000]);
  });

  it('ADR-0018 the batch timeout comes from configuration, 60 s when nothing is set', async () => {
    const h = await start();
    await request(h.app.httpServer)
      .post('/reconciliation/run')
      .set('Authorization', `Bearer ${h.tokens.person('admin')}`)
      .send({ date: '2026-10-18' });
    expect(longer()).toEqual([60000]);
  });

  it('ADR-0018 a listing of held transactions keeps 3 s (NFR-12)', async () => {
    const h = await start({ BATCH_HTTP_TIMEOUT_MS: '45000' });
    const response = await request(h.app.httpServer)
      .get('/transaction/held')
      .set('Authorization', `Bearer ${h.tokens.person('fraud_analyst')}`);
    expect(response.status).toBe(200);
    expect(longer()).toEqual([]);
  });

  it('ADR-0018 an audit request keeps 3 s (NFR-12), the other admin-console POST', async () => {
    const h = await start({ BATCH_HTTP_TIMEOUT_MS: '45000' });
    const response = await request(h.app.httpServer)
      .post('/reconciliation/audit-request')
      .set('Authorization', `Bearer ${h.tokens.person('auditor')}`)
      .send({ transaction_id: 'TX-1760860800000001', reason_code: 'DISPUTE' });
    expect(response.status).toBe(200);
    expect(longer()).toEqual([]);
  });

  it('ADR-0018 a batch timeout that is not a positive whole number stops the start', async () => {
    await expect(start({ BATCH_HTTP_TIMEOUT_MS: '0' })).rejects.toThrow();
  });
});
