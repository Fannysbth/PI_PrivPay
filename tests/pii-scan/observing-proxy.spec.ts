import { readFileSync, readdirSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildCanary } from './canary';
import { ObservingProxy } from './observing-proxy';

// Seam: ObservingProxy between a client and a stub service. Values are the generated canaries.
const person = buildCanary(21);
let target: Server;
let proxy: ObservingProxy;
let seenByTarget: string[];

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    }),
  );

beforeEach(async () => {
  seenByTarget = [];
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seenByTarget.push(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.url?.startsWith('/leaky') ? 201 : 200;
      res.end(
        req.url?.startsWith('/leaky') ? JSON.stringify({ echoed: person.nama }) : '{"ok":true}',
      );
    });
  });
  const port = await listen(target);
  proxy = new ObservingProxy({
    service: 'transaction',
    target: `http://127.0.0.1:${String(port)}`,
    canaries: [person],
  });
  await proxy.start();
});
afterEach(async () => {
  await proxy.stop();
  await new Promise((resolve) => target.close(resolve));
});

function call(path: string, body: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('M2-10 observing proxy', () => {
  it('M2-10 negative: clean traffic is forwarded unchanged and gives no finding', async () => {
    const answer = await call('/pay', '{"pseudonym":"PSEU-0A1B2C3D"}');
    expect(answer).toEqual({ status: 200, body: '{"ok":true}' });
    expect(seenByTarget).toEqual(['{"pseudonym":"PSEU-0A1B2C3D"}']);
    expect(proxy.findings()).toEqual([]);
  });

  it('M2-10 positive: a canary in the request body is found, with the service of the proxy', async () => {
    await call('/pay', `{"customer_id":"${person.customer_id}"}`);
    expect(proxy.findings()).toEqual([
      { attribute: 'customer_id', location: 'request-body', service: 'transaction' },
    ]);
    expect(seenByTarget).toHaveLength(1);
  });

  it('M2-10 positive: a canary in the URL, in a header and in the response body is found', async () => {
    await call(`/leaky?nik=${person.nik}`, '{}', { 'x-note': person.hp });
    expect(proxy.findings()).toEqual(
      expect.arrayContaining([
        { attribute: 'nik', location: 'url', service: 'transaction' },
        { attribute: 'hp', location: 'request-header', service: 'transaction' },
        { attribute: 'nama', location: 'response-body', service: 'transaction' },
      ]),
    );
    expect(proxy.findings()).toHaveLength(3);
  });

  it('M2-10 the findings carry no value, and the proxy keeps no payload', async () => {
    await call('/leaky', Object.values(person).join(' '));
    const printed = JSON.stringify(proxy.findings());
    for (const value of Object.values(person)) expect(printed).not.toContain(value);
    for (const finding of proxy.findings()) {
      expect(Object.keys(finding).sort()).toEqual(['attribute', 'location', 'service']);
    }
  });

  it('M2-10 the harness code never imports the file system (payloads stay in memory)', () => {
    const files = readdirSync(__dirname).filter(
      (name) => name.endsWith('.ts') && !name.includes('.spec.'),
    );
    for (const name of files) {
      expect(readFileSync(join(__dirname, name), 'utf8')).not.toMatch(
        /from 'node:fs|require\('(node:)?fs/,
      );
    }
  });

  it('M2-10 an unreachable service is a 502 and not a hang', async () => {
    await new Promise((resolve) => target.close(resolve));
    const answer = await call('/pay', '{}');
    expect(answer.status).toBe(502);
    target = createServer();
  });
});
