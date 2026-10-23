import 'reflect-metadata';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, ROLE_SERVICES, safeEqual, signJwt, type HumanRole } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { gatewayModules } from '../src/gateway.module';
import type { Route } from '../src/routes';

// Everything here is made up for the test run: keys, secrets, tokens, hosts.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const ISSUER = 'privpay-dev-idp';
export const KID = 'gateway-test-key';
export const START = new Date('2026-10-19T08:00:00Z');
export const GATEWAY_SECRET = 'fake-secret-api-gateway-0123456789abcdef';
export const HOSTS = {
  idp: 'idp.test',
  'privacy-service': 'privacy.test',
  'transaction-service': 'transaction.test',
  'reconciliation-service': 'reconciliation.test',
  'notification-service': 'notification.test',
} as const;

export interface Recorded {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}
export type Responder = (request: Recorded) => { status: number; body?: unknown } | 'network-error';

/** A network of fake hosts: the IdP (JWKS and token) and the three services, each recording what it was asked. */
export class FakeNetwork {
  readonly requests: Recorded[] = [];
  readonly tokenRequests: { audience: string[] }[] = [];
  jwksFailing = false;
  jwksFetches = 0;
  private readonly responders = new Map<string, Responder>();

  constructor(private readonly clock: FakeClock) {}

  respond(host: string, responder: Responder): void {
    this.responders.set(host, responder);
  }

  to(host: string): Recorded[] {
    return this.requests.filter((r) => r.host === host);
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const recorded: Recorded = {
      host: url.hostname,
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      headers,
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
    };
    this.requests.push(recorded);
    const json = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );

    if (url.hostname === HOSTS.idp) return this.idp(recorded, json);
    const responder = this.responders.get(url.hostname);
    const answer =
      responder === undefined ? { status: 200, body: { ok: true } } : responder(recorded);
    if (answer === 'network-error')
      return Promise.reject(new TypeError('connection refused to ' + url.hostname));
    return answer.body === undefined
      ? Promise.resolve(new Response(null, { status: answer.status }))
      : json(answer.status, answer.body);
  };

  private idp(
    request: Recorded,
    json: (status: number, body: unknown) => Promise<Response>,
  ): Promise<Response> {
    if (request.path === '/.well-known/jwks.json') {
      this.jwksFetches += 1;
      if (this.jwksFailing) return Promise.reject(new TypeError('connection refused to idp'));
      return json(200, {
        keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }],
      });
    }
    if (request.path === '/token') {
      const body = request.body as {
        client_id?: string;
        client_secret?: string;
        audience?: string[];
      };
      if (body.client_id !== 'api-gateway' || !safeEqual(body.client_secret ?? '', GATEWAY_SECRET))
        return json(401, { error: { code: 'UNAUTHENTICATED' } });
      this.tokenRequests.push({ audience: body.audience ?? [] });
      const iat = Math.floor(this.clock.now().getTime() / 1000);
      const token = signJwt(
        {
          iss: ISSUER,
          sub: 'api-gateway',
          azp: 'api-gateway',
          aud: body.audience,
          iat,
          exp: iat + 300,
          jti: 'fake-jti',
        },
        { privateKey: pair.privateKey, kid: KID },
      );
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 300 });
    }
    return json(404, {});
  }
}

const mint = (
  claims: Record<string, unknown>,
  clock: FakeClock,
  key = pair.privateKey,
  kid = KID,
): string => {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return signJwt(
    { iss: ISSUER, iat, exp: iat + 300, jti: 'fake-jti', ...claims },
    { privateKey: key, kid },
  );
};

/** Tokens as the dev IdP would issue them, signed with the test key. */
export function tokens(clock: FakeClock): {
  person: (role: HumanRole, extra?: Record<string, unknown>) => string;
  customer: () => string;
  bank: () => string;
  service: (client: string, aud: string[]) => string;
  foreign: (role: HumanRole) => string;
  algNone: (role: HumanRole) => string;
  hs256: (role: HumanRole) => string;
} {
  return {
    person: (role, extra = {}) =>
      mint(
        {
          sub: `usr-${role}`,
          azp: 'admin-console',
          aud: ROLE_SERVICES[role],
          roles: [role],
          ...extra,
        },
        clock,
      ),
    customer: () =>
      mint(
        {
          sub: 'usr-cust-000101',
          azp: 'customer-app',
          aud: ['api-gateway'],
          roles: ['customer'],
          customer_id: 'CUST-000101',
        },
        clock,
      ),
    bank: () =>
      mint(
        { sub: 'usr-bank-01', azp: 'bank-simulator', aud: ['api-gateway'], roles: ['bank'] },
        clock,
      ),
    service: (client, aud) => mint({ sub: client, azp: client, aud }, clock),
    // The classic confusions: no signature at all, and a MAC made with the public key as the secret.
    algNone: (role) => {
      const iat = Math.floor(clock.now().getTime() / 1000);
      const segment = (value: unknown): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const claims = {
        iss: ISSUER,
        sub: `usr-${role}`,
        azp: 'admin-console',
        aud: ROLE_SERVICES[role],
        roles: [role],
        iat,
        exp: iat + 300,
      };
      return `${segment({ alg: 'none', typ: 'JWT', kid: KID })}.${segment(claims)}.`;
    },
    hs256: (role) => {
      const iat = Math.floor(clock.now().getTime() / 1000);
      const segment = (value: unknown): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const head = segment({ alg: 'HS256', typ: 'JWT', kid: KID });
      const body = segment({
        iss: ISSUER,
        sub: `usr-${role}`,
        azp: 'admin-console',
        aud: ROLE_SERVICES[role],
        roles: [role],
        iat,
        exp: iat + 300,
      });
      const mac = createHmac('sha256', pair.publicKey.export({ type: 'spki', format: 'pem' }))
        .update(`${head}.${body}`)
        .digest('base64url');
      return `${head}.${body}.${mac}`;
    },
    foreign: (role) =>
      mint(
        { sub: `usr-${role}`, azp: 'admin-console', aud: ROLE_SERVICES[role], roles: [role] },
        clock,
        stranger.privateKey,
      ),
  };
}

export interface Harness {
  readonly app: ServiceApp;
  readonly clock: FakeClock;
  readonly network: FakeNetwork;
  readonly logLines: string[];
  readonly tokens: ReturnType<typeof tokens>;
  close(): Promise<void>;
}

/** The gateway app wired to the fake network, a fake clock and a throwaway secrets file. */
export async function startGateway(
  env: Record<string, string | undefined> = {},
  // `wrapFetch` lets a test send some hosts to a real service (an integration test) and the rest to the fake network.
  options: { routes?: readonly Route[]; wrapFetch?: (inner: typeof fetch) => typeof fetch } = {},
): Promise<Harness> {
  const clock = new FakeClock(START);
  const network = new FakeNetwork(clock);
  const dir = mkdtempSync(join(tmpdir(), 'privpay-gateway-'));
  const secretFile = join(dir, 'api_gateway_client_secret');
  writeFileSync(secretFile, `${GATEWAY_SECRET}\n`);
  const logLines: string[] = [];
  const app = await createServiceApp(
    {
      service: 'gateway',
      modules: gatewayModules({
        fetch: options.wrapFetch === undefined ? network.fetch : options.wrapFetch(network.fetch),
        ...(options.routes === undefined ? {} : { routes: options.routes }),
      }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      IDP_URL: `http://${HOSTS.idp}`,
      PRIVACY_SERVICE_URL: `http://${HOSTS['privacy-service']}`,
      TRANSACTION_SERVICE_URL: `http://${HOSTS['transaction-service']}`,
      RECONCILIATION_SERVICE_URL: `http://${HOSTS['reconciliation-service']}`,
      NOTIFICATION_SERVICE_URL: `http://${HOSTS['notification-service']}`,
      API_GATEWAY_CLIENT_SECRET_FILE: secretFile,
      ...env,
    },
    { clock, logDestination: { write: (line) => void logLines.push(line) } },
  );
  return {
    app,
    clock,
    network,
    logLines,
    tokens: tokens(clock),
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
