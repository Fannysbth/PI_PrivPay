import { randomUUID } from 'node:crypto';
import { buildCanary } from '../pii-scan/canary';
import { call, docker, edge, KONG_PORT, login, logs, MODE, PROJECT, runIndex } from './helpers';

// DK-02b (invariant 8, NFR-11): with the Privacy Service switched off, a payment through Kong ends at Kong with 503 in the
// one shape of ADR-0008. The adapter must not even see the request: its log has no trace of the request id. (The adapter
// would also refuse a raw payment, 503 as well, so only the log tells whether Kong's own guard held.) Then the service is
// switched on again and a payment passes. Only the proposed condition has a Privacy Service to switch off.
// This is a test of DK-02b, not the fail-closed acceptance of M7 (NFR-19), which has its own ticket and conditions.
const canary = buildCanary(runIndex(1));
const username = `uji.tutup.${canary.nik.slice(-6)}`;
const PRIVACY = `${PROJECT}-privacy-service-1`;
const REQUEST_ID = randomUUID();

function waitHealthy(container: string): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = docker(['inspect', '--format', '{{.State.Health.Status}}', container]).trim();
    if (status === 'healthy') return;
    // Real time is the point here: the container really has to come back.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error('the Privacy Service did not become healthy again');
}

const pay = async (token: string, key: string, requestId?: string) =>
  edge(
    '/transaction',
    {
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
    { source_account: canary.rekening, merchant_id: 'MRC-001', amount: 12000, geohash: 'qqgu4' },
  );

// Only the proposed condition has a Privacy Service to switch off, so the suite exists only there.
if (MODE === 'proposed') {
  describe('DK-02b Privacy switched off: Kong fails closed', () => {
    it('DK-02b 503 SERVICE_UNAVAILABLE from Kong, the adapter never saw it, and a payment passes after the restart', async () => {
      const registered = await call(
        { port: KONG_PORT, path: '/register', tls: true },
        {
          nik: canary.nik,
          nama: canary.nama,
          hp: canary.hp,
          email: canary.email,
          rekening: canary.rekening,
          username,
        },
      );
      expect(registered.status).toBe(201);
      const token = await login(username);
      try {
        docker(['stop', PRIVACY]);
        const refused = await pay(token, randomUUID(), REQUEST_ID);
        expect(refused.status).toBe(503);
        expect(refused.body).toMatchObject({
          error: { code: 'SERVICE_UNAVAILABLE', request_id: REQUEST_ID },
        });
        expect(logs('gateway')).not.toContain(REQUEST_ID);
      } finally {
        docker(['start', PRIVACY]);
        waitHealthy(PRIVACY);
      }
      const recovered = await pay(token, randomUUID());
      expect(recovered.status).toBe(201);
    }, 150_000);
  });
}
