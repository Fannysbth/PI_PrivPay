import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

// Shared by the tests that drive the RUNNING Compose stack (`pnpm test:edge`, DK-02b): a client for the TLS edge (Kong)
// that verifies the development CA, a plain client for Keycloak (published on loopback by docs/postman/compose.postman.yml),
// and the few docker commands they need. Nothing here prints a token, a key or a certificate.
export const MODE = process.env['PRIVPAY_STACK_MODE'] === 'baseline' ? 'baseline' : 'proposed';
export const PROJECT = `privpay-${MODE}`;
export const KONG_PORT = MODE === 'proposed' ? 4010 : 4011;
const SECRETS_DIR =
  process.env['DOCKER_SECRETS_DIR'] ?? join(__dirname, '..', '..', 'secrets', 'docker');
const CA = readFileSync(join(SECRETS_DIR, 'tls_ca.crt'));

export interface Answer {
  status: number;
  body: unknown;
}

export function call(
  options: {
    port: number;
    path: string;
    method?: string;
    headers?: Record<string, string>;
    tls: boolean;
  },
  body?: object,
): Promise<Answer> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const make = options.tls ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = make(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'POST',
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
          ...options.headers,
        },
        ...(options.tls ? { ca: CA } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

export const edge = (
  path: string,
  headers: Record<string, string>,
  body: object,
): Promise<Answer> => call({ port: KONG_PORT, path, headers, tls: true }, body);

// DK-04: Keycloak signs a customer in by password grant. The one test password (invented) comes from its secret file and is
// never printed. Keycloak is published on the loopback by docs/postman/compose.postman.yml.
export async function login(username: string): Promise<string> {
  const port = process.env['IDP_HOST_PORT'] ?? '8080';
  const response = await fetch(
    'http://127.0.0.1:' + port + '/realms/privpay/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'customer-app',
        username,
        password: readFileSync(join(SECRETS_DIR, 'keycloak_dev_user_password'), 'utf8').trim(),
      }).toString(),
    },
  );
  const body = (await response.json()) as { access_token?: string };
  if (typeof body.access_token !== 'string') throw new Error('Keycloak gave no token');
  return body.access_token;
}

export function docker(args: string[]): string {
  const run = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`docker ${args[0] ?? ''} failed`);
  return `${run.stdout}${run.stderr}`;
}

export const logs = (service: string): string => docker(['logs', `${PROJECT}-${service}-1`]);

/** A canary index that differs per run (the stack keeps its data between runs); `half` keeps two specs apart. */
export const runIndex = (half: 0 | 1): number =>
  (Math.floor(Date.now() / 1000) % 50_000) + half * 50_000;
