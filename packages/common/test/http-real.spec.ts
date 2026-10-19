import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpClient } from '../src/http';

// Real sockets, but no timers or sleeps: these tests confirm that the production fetch behaves as assumed.
describe('M0-03 the client against a real local server', () => {
  const seen: { path: string | undefined; requestId: string | string[] | undefined }[] = [];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ path: request.url, requestId: request.headers['x-request-id'] });
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/landing' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const client = () =>
    createHttpClient({ baseUrls: { svc: baseUrl }, timeoutMs: 2000, maxRetries: 2 });

  it('M0-03 does not follow a redirect and hands the 3xx back to the caller (API7)', async () => {
    seen.length = 0;
    const response = await client().request({
      service: 'svc',
      method: 'GET',
      path: '/redirect',
      idempotent: true,
    });
    expect(response.status).toBe(302);
    expect(seen.map((entry) => entry.path)).toEqual(['/redirect']);
  });

  it('M0-03 sends the request id header and parses the JSON answer', async () => {
    seen.length = 0;
    const requestId = '3f2b9c1e-6d1a-4e55-9a40-0c1d8e7a2b11';
    const response = await client().request({
      service: 'svc',
      method: 'GET',
      path: '/echo',
      idempotent: true,
      requestId,
    });
    expect(response).toEqual({ status: 200, body: { path: '/echo' } });
    expect(seen[0]?.requestId).toBe(requestId);
  });
});
