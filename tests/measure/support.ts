import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '../pii-scan/scan';
import { docker, PROJECT } from '../docker/helpers';

// Shared by the M6 measurements (`pnpm measure:exposure`, docs/hasil/README.md). They drive the RUNNING Compose stack
// started with deploy/measure/compose.measure.yml. Secrets are read from their files at run time by this code and are never
// printed; the tests that already drive the stack (tests/docker) do the same.
const SECRETS_DIR =
  process.env['DOCKER_SECRETS_DIR'] ?? join(__dirname, '..', '..', 'secrets', 'docker');
export const secretFile = (name: string): string =>
  readFileSync(join(SECRETS_DIR, name), 'utf8').trim();

const IDP = `http://127.0.0.1:${process.env['IDP_HOST_PORT'] ?? '8080'}`;

export interface TokenRequest {
  readonly client: string;
  readonly username?: string;
  readonly passwordFile?: string;
  readonly secretFile?: string;
}

/** A token from Keycloak by password grant (a person) or client credentials (a service account). Never printed. */
export async function tokenFor(request: TokenRequest): Promise<string> {
  const form = new URLSearchParams({ client_id: request.client });
  if (request.username !== undefined && request.passwordFile !== undefined) {
    form.set('grant_type', 'password');
    form.set('username', request.username);
    form.set('password', secretFile(request.passwordFile));
  } else {
    form.set('grant_type', 'client_credentials');
  }
  if (request.secretFile !== undefined) form.set('client_secret', secretFile(request.secretFile));
  const response = await fetch(`${IDP}/realms/privpay/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = (await response.json()) as { access_token?: string };
  if (typeof body.access_token !== 'string') {
    throw new Error(`Keycloak gave no token for ${request.client}`);
  }
  return body.access_token;
}

export const ROLE_TOKENS = {
  analyst: {
    client: 'admin-console',
    username: 'analis.uji.1',
    passwordFile: 'keycloak_password_analyst',
    secretFile: 'admin-console_client_secret',
  },
  auditor: {
    client: 'admin-console',
    username: 'auditor.uji.1',
    passwordFile: 'keycloak_password_auditor',
    secretFile: 'admin-console_client_secret',
  },
  admin: {
    client: 'admin-console',
    username: 'admin.uji.1',
    passwordFile: 'keycloak_password_admin',
    secretFile: 'admin-console_client_secret',
  },
  bank: {
    client: 'bank-simulator',
    username: 'bank.uji.1',
    passwordFile: 'keycloak_password_bank',
  },
} as const satisfies Record<string, TokenRequest>;

export function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  if (payload === undefined) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Runs `work` over `items` with at most `width` in flight; the first failure rejects. */
export async function inPool<T>(
  items: readonly T[],
  width: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await work(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

export const OBSERVER = `http://127.0.0.1:${process.env['OBSERVER_HOST_PORT'] ?? '4199'}`;

export interface PayloadFinding {
  readonly service: string;
  readonly attribute: Finding['attribute'];
  readonly place: 'payload';
}

export async function observerScan(
  canaries: readonly object[],
): Promise<{ exchanges: number; findings: PayloadFinding[] }> {
  const response = await fetch(`${OBSERVER}/scan`, {
    method: 'POST',
    body: JSON.stringify({ canaries }),
  });
  if (!response.ok) throw new Error('the observer refused the scan');
  return (await response.json()) as { exchanges: number; findings: PayloadFinding[] };
}

export const containerOf = (service: string): string => `${PROJECT}-${service}-1`;

/** The data of one service database as text (owner role of the container; test only). */
export const pgDump = (service: string): string =>
  docker([
    'exec',
    containerOf(`pg-${service}`),
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    `privpay_${service}`,
    '--data-only',
  ]);

export const containerLogs = (name: string): string => docker(['logs', name]);

export function commitInfo(): { commit: string; dirty: boolean } {
  const run = (args: string[]): string =>
    spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
  return { commit: run(['rev-parse', 'HEAD']), dirty: run(['status', '--porcelain']).length > 0 };
}

export function imageVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  const names = docker([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--format',
    '{{.Names}}',
  ]);
  for (const name of names.trim().split(String.fromCharCode(10))) {
    if (name === '') continue;
    const [image, id] = docker(['inspect', '-f', '{{.Config.Image}} {{.Image}}', name])
      .trim()
      .split(' ');
    out[name.replace(`${PROJECT}-`, '').replace(/-1$/, '')] =
      `${image ?? '?'} ${(id ?? '').slice(0, 19)}`;
  }
  return out;
}
