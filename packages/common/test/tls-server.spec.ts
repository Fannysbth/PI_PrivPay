import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../src/config';
import { createServiceApp, type ServiceApp, type ServiceDefinition } from '../src/nest';

// DK-03 (NFR-06): the Privacy Service listens with TLS and callers verify it. The certificates are made by the same
// `openssl` helper the Docker setup uses (scripts/docker/tls.cjs); no key or certificate is stored in the repository.
interface Pair {
  key: string;
  crt: string;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tls = require('../../../scripts/docker/tls.cjs') as {
  issueCa(dir: string): Pair;
  issueServer(
    dir: string,
    ca: Pair,
    options: { name: string; dnsNames: string[]; notBefore: Date; notAfter: Date },
  ): Pair;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const baseEnv = { PRIVACY_MODE: 'proposed', PORT: '0' };
const definition: ServiceDefinition = { service: 'privacy-service', modules: [] };

let dir: string;
let ca: Pair;
let otherCa: Pair;
let good: Pair;
let expired: Pair;
let wrongName: Pair;
const running: ServiceApp[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-tls-spec-'));
  ca = tls.issueCa(join(dir, 'ca'));
  otherCa = tls.issueCa(join(dir, 'other-ca'));
  const now = Date.now();
  const valid = { notBefore: new Date(now - HOUR), notAfter: new Date(now + DAY) };
  // The name the test callers use is `localhost`: `privacy-service` only resolves inside Docker.
  good = tls.issueServer(dir, ca, { name: 'good', dnsNames: ['localhost'], ...valid });
  expired = tls.issueServer(dir, ca, {
    name: 'expired',
    dnsNames: ['localhost'],
    notBefore: new Date(now - 3 * DAY),
    notAfter: new Date(now - DAY),
  });
  wrongName = tls.issueServer(dir, ca, { name: 'wrong', dnsNames: ['somebody-else'], ...valid });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Every test closes what it opened, also after a failed assertion.
afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

async function serve(pair: Pair | undefined): Promise<number> {
  const env =
    pair === undefined ? baseEnv : { ...baseEnv, TLS_CERT_FILE: pair.crt, TLS_KEY_FILE: pair.key };
  const app = await createServiceApp(definition, env);
  running.push(app);
  return (await app.listen()).port;
}

/** A verifying TLS request to localhost, trusting only `caFile`. */
function get(port: number, caFile: string, legacy = false): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: 'localhost',
        port,
        path: '/health',
        ca: readFileSync(caFile),
        // A client that really offers TLS 1.1 (and nothing newer), so only the server can be the reason it is refused.
        ...(legacy
          ? { minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' }
          : {}),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('DK-03 the Privacy Service listens with TLS (NFR-06)', () => {
  it('DK-03 accepts a caller that trusts the CA and checks the name', async () => {
    const port = await serve(good);
    await expect(get(port, ca.crt)).resolves.toBe(200);
  });

  it('DK-03 refuses a plain HTTP connection to the TLS port', async () => {
    const port = await serve(good);
    const outcome = await new Promise<string>((resolve) => {
      const req = httpRequest({ host: 'localhost', port, path: '/health' }, (res) => {
        res.resume();
        resolve(`status ${String(res.statusCode)}`);
      });
      req.on('error', () => {
        resolve('refused');
      });
      req.end();
    });
    expect(outcome).toBe('refused');
  });

  it('DK-03 a caller that trusts another CA rejects the certificate', async () => {
    const port = await serve(good);
    await expect(get(port, otherCa.crt)).rejects.toMatchObject({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
  });

  it('DK-03 rejects an expired certificate', async () => {
    const port = await serve(expired);
    await expect(get(port, ca.crt)).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' });
  });

  it('DK-03 rejects a certificate issued for another name', async () => {
    const port = await serve(wrongName);
    await expect(get(port, ca.crt)).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });

  it('DK-03 refuses a TLS 1.1-only client (also the Node default; minVersion makes it explicit)', async () => {
    const port = await serve(good);
    await expect(get(port, ca.crt, true)).rejects.toBeDefined();
  });
});

describe('DK-03 the TLS settings are validated at start-up', () => {
  it('DK-03 a certificate without a key, or a key without a certificate, stops the service', async () => {
    await expect(
      createServiceApp(definition, { ...baseEnv, TLS_CERT_FILE: good.crt }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      createServiceApp(definition, { ...baseEnv, TLS_KEY_FILE: good.key }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('DK-03 an unreadable certificate file stops the service naming the variable only', async () => {
    const error = await createServiceApp(definition, {
      ...baseEnv,
      TLS_CERT_FILE: join(dir, 'missing.crt'),
      TLS_KEY_FILE: good.key,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([
      { name: 'TLS_CERT_FILE', problem: 'unreadable' },
    ]);
  });

  it('DK-03 NODE_TLS_REJECT_UNAUTHORIZED=0 (verification off) stops the service', async () => {
    const error = await createServiceApp(definition, {
      ...baseEnv,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', problem: 'invalid' },
    ]);
  });
});

describe('DK-03 the real client path (global fetch with NODE_EXTRA_CA_CERTS) verifies the server', () => {
  // The services call Privacy with Node's global fetch and the CA reaches it through NODE_EXTRA_CA_CERTS, which Node
  // reads at start: a child process is the only way to test that, exactly as in the containers.
  // Asynchronous on purpose: the server under test lives in this process, which must stay free to answer the child.
  function fetchFromChild(
    port: number,
    extraCa: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const script = `fetch('https://localhost:${String(port)}/health').then(r=>console.log('status '+r.status),e=>console.log('error '+((e.cause&&e.cause.code)||e.code)))`;
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['-e', script],
        {
          timeout: 15_000,
          // SystemRoot is needed by Node on Windows to initialise sockets and crypto.
          env: {
            PATH: process.env['PATH'] ?? '',
            SystemRoot: process.env['SystemRoot'] ?? '',
            NODE_EXTRA_CA_CERTS: extraCa,
            ...extraEnv,
          },
        },
        (error, stdout) => {
          if (error === null) resolve(stdout.trim());
          else reject(error instanceof Error ? error : new Error('child failed'));
        },
      );
    });
  }

  it('DK-03 trusts the dev CA', async () => {
    const port = await serve(good);
    await expect(fetchFromChild(port, ca.crt)).resolves.toBe('status 200');
  });

  it('DK-03 rejects a server whose CA it was not given', async () => {
    const port = await serve(good);
    await expect(fetchFromChild(port, otherCa.crt)).resolves.toBe(
      'error UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    );
  });

  it('DK-03 rejects an expired certificate', async () => {
    const port = await serve(expired);
    await expect(fetchFromChild(port, ca.crt)).resolves.toBe('error CERT_HAS_EXPIRED');
  });

  it('DK-03 rejects a certificate for another name', async () => {
    const port = await serve(wrongName);
    await expect(fetchFromChild(port, ca.crt)).resolves.toBe('error ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('DK-03 control: with verification switched off the wrong CA is accepted (what the start-up guard forbids)', async () => {
    const port = await serve(good);
    await expect(
      fetchFromChild(port, otherCa.crt, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    ).resolves.toBe('status 200');
  });
});
