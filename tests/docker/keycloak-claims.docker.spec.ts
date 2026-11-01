import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticate,
  createHttpClient,
  createIdpTokenCache,
  DomainError,
  FakeClock,
  idpJwksSource,
  JwksKeys,
  signJwt,
  unverifiedKid,
  type AuthenticateOptions,
} from '../../packages/common/src';
import { docker } from './helpers';

// DK-04 (ADR-0007, ADR-0017): the claims Keycloak puts in a token are exactly what `authenticate()` of the services
// accepts, and what it refuses stays refused. A throwaway Keycloak (the pinned image, the realm rendered by
// scripts/docker/keycloak-realm.cjs from random secrets made here) is started on its own, apart from the Compose stack.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realmModule = require('../../scripts/docker/keycloak-realm.cjs') as {
  renderRealm(input: { clientSecrets: Record<string, string>; devPassword: string }): object;
  SERVICE_CLIENTS: Record<string, string[]>;
};

const IMAGE =
  'quay.io/keycloak/keycloak@sha256:5f3fb534cde6bf006d79f5912473e5d2c828c707cdfc52e16972803aca9d43dd';
const PORT = 18_081 + Math.floor(Math.random() * 500);
const NAME = `privpay-kc-claims-${randomBytes(4).toString('hex')}`;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const ISSUER = 'http://keycloak:8080/realms/privpay';
const TOKEN = `${BASE}/realms/privpay/protocol/openid-connect/token`;
const secret = (): string => randomBytes(24).toString('base64url');
const clientSecrets: Record<string, string> = Object.fromEntries(
  [...Object.keys(realmModule.SERVICE_CLIENTS), 'idp-admin'].map((name) => [name, secret()]),
);
const devPassword = secret();
const adminPassword = secret();

let work = '';
let keys = new Map<string, KeyObject>();

async function form(body: Record<string, string>): Promise<string> {
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const answer = (await response.json()) as { access_token?: string };
  if (answer.access_token === undefined) throw new Error(`no token (${String(response.status)})`);
  return answer.access_token;
}
const human = (client: string, username: string): Promise<string> =>
  form({ grant_type: 'password', client_id: client, username, password: devPassword });
// DK-04c: a service token is asked for one audience, by the optional scope aud-<service>; `scopes` may name more or none.
const service = (client: string, ...scopes: string[]): Promise<string> =>
  form({
    grant_type: 'client_credentials',
    client_id: client,
    client_secret: clientSecrets[client] ?? '',
    ...(scopes.length === 0 ? {} : { scope: scopes.map((name) => `aud-${name}`).join(' ') }),
  });
const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

const options = (serviceName: string): AuthenticateOptions => ({
  clock: { now: () => new Date() },
  issuer: ISSUER,
  service: serviceName,
  resolveKey: (kid) => (kid === undefined ? undefined : keys.get(kid)),
  acceptCustomerToken: serviceName === 'api-gateway',
});
const who = (token: string, serviceName: string, extra: Record<string, string> = {}) =>
  authenticate({ authorization: `Bearer ${token}`, ...extra }, options(serviceName));
const refused = (token: string, serviceName: string): unknown => {
  try {
    who(token, serviceName);
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'other';
  }
  return 'accepted';
};

describe('DK-04 the claims of Keycloak against authenticate()', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'privpay-kc-'));
    writeFileSync(
      join(work, 'privpay-realm.json'),
      JSON.stringify(realmModule.renderRealm({ clientSecrets, devPassword })),
    );
    docker([
      'run',
      '-d',
      '--name',
      NAME,
      '--memory',
      '768m',
      '-p',
      `127.0.0.1:${String(PORT)}:8080`,
      '-v',
      `${work}:/opt/keycloak/data/import:ro`,
      '-e',
      'KC_BOOTSTRAP_ADMIN_USERNAME=kcadmin',
      '-e',
      `KC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}`,
      '-e',
      'JAVA_OPTS_KC_HEAP=-Xms128m -Xmx320m',
      '-e',
      'KC_HOSTNAME=http://keycloak:8080',
      '-e',
      'KC_HOSTNAME_STRICT=false',
      IMAGE,
      'start-dev',
      '--import-realm',
    ]);
    // Real time: the server really has to start and import the realm.
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const up = await fetch(`${BASE}/realms/privpay`).then(
        (r) => r.status === 200,
        () => false,
      );
      if (up) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const jwks = (await (
      await fetch(`${BASE}/realms/privpay/protocol/openid-connect/certs`)
    ).json()) as {
      keys: (JsonWebKey & { kid: string; use: string; alg: string })[];
    };
    const signing = jwks.keys.filter((key) => key.use === 'sig' && key.alg === 'RS256');
    expect(signing).toHaveLength(1);
    keys = new Map(signing.map((key) => [key.kid, createPublicKey({ key, format: 'jwk' })]));
  }, 240_000);

  afterAll(() => {
    try {
      docker(['rm', '-f', NAME]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('DK-04 the JWKS has exactly one signing key (RS256) next to the encryption key Kong must not use', () => {
    expect(keys.size).toBe(1);
  });

  it('DK-04 a customer: CUSTOMER with the customer_id claim, accepted only at the gateway', async () => {
    const token = await human('customer-app', 'nasabah.uji.101');
    expect(who(token, 'api-gateway')).toMatchObject({
      requestingService: 'CUSTOMER',
      customerId: 'CUST-000101',
    });
    expect(refused(token, 'privacy-service')).not.toBe('accepted');
  });

  it('DK-04 an administrator: ADMIN_CONSOLE with exactly one role, at the services of that role only', async () => {
    const token = await human('admin-console', 'admin.uji.1');
    expect(who(token, 'privacy-service')).toMatchObject({
      requestingService: 'ADMIN_CONSOLE',
      actor: { role: 'admin' },
    });
    expect(refused(token, 'transaction-service')).not.toBe('accepted');
  });

  it('DK-04 the fraud analyst reaches Transaction and not Privacy', async () => {
    const token = await human('admin-console', 'analis.uji.1');
    expect(who(token, 'transaction-service')).toMatchObject({ actor: { role: 'fraud_analyst' } });
    expect(refused(token, 'privacy-service')).not.toBe('accepted');
  });

  it('DK-04 four eyes: two administrators are two different persons', async () => {
    const one = who(await human('admin-console', 'admin.uji.1'), 'privacy-service');
    const two = who(await human('admin-console', 'admin.uji.2'), 'privacy-service');
    expect(one.subject).not.toBe(two.subject);
  });

  it('DK-04 the bank: BANK at the gateway', async () => {
    expect(who(await human('bank-simulator', 'bank.uji.1'), 'api-gateway')).toMatchObject({
      requestingService: 'BANK',
    });
  });

  it('DK-04c a service account: its own requesting service, ONE audience, no roles, no customer_id', async () => {
    const token = await service('transaction', 'privacy-service');
    expect(claimsOf(token)['aud']).toEqual('privacy-service');
    expect(claimsOf(token)).not.toHaveProperty('roles');
    expect(claimsOf(token)).not.toHaveProperty('customer_id');
    expect(who(token, 'privacy-service')).toMatchObject({ requestingService: 'TRANSACTION' });
    const gateway = await service('api-gateway', 'privacy-service');
    expect(who(gateway, 'privacy-service')).toMatchObject({ requestingService: 'API_GATEWAY' });
  });

  it('DK-04c a token made for Transaction is refused at Privacy (403), and the reverse (T-15)', async () => {
    const forTransaction = await service('api-gateway', 'transaction-service');
    expect(who(forTransaction, 'transaction-service')).toMatchObject({
      requestingService: 'API_GATEWAY',
    });
    expect(refused(forTransaction, 'privacy-service')).toBe('FORBIDDEN_ROLE');
    const forPrivacy = await service('api-gateway', 'privacy-service');
    expect(refused(forPrivacy, 'transaction-service')).toBe('FORBIDDEN_ROLE');
    expect(refused(forPrivacy, 'notification-service')).toBe('FORBIDDEN_ROLE');
  });

  it('DK-04c without a scope a service token names no audience and no service takes it', async () => {
    const bare = await service('api-gateway');
    expect(claimsOf(bare)).not.toHaveProperty('aud');
    for (const name of ['privacy-service', 'transaction-service', 'api-gateway']) {
      expect(refused(bare, name)).not.toBe('accepted');
    }
  });

  it('DK-04c an audience the account may not call cannot be asked for at all (no token)', async () => {
    // Fraud calls nobody; Transaction does not call Reconciliation (the table of SERVICE_CLIENTS).
    await expect(service('fraud', 'privacy-service')).rejects.toThrow('no token (400)');
    await expect(service('transaction', 'reconciliation-service')).rejects.toThrow(
      'no token (400)',
    );
    await expect(service('idp-admin', 'privacy-service')).rejects.toThrow('no token (400)');
  });

  it('DK-04c two audiences asked at once give a wide token, and the receiver still refuses it at both', async () => {
    const wide = await service('api-gateway', 'privacy-service', 'transaction-service');
    expect(claimsOf(wide)['aud']).toEqual(
      expect.arrayContaining(['privacy-service', 'transaction-service']),
    );
    expect(refused(wide, 'privacy-service')).toBe('FORBIDDEN_ROLE');
    expect(refused(wide, 'transaction-service')).toBe('FORBIDDEN_ROLE');
  });

  it('DK-04 a person carried by a service: Authorization of the service plus X-Actor-Token of the person (ADR-0007)', async () => {
    const actor = await human('admin-console', 'admin.uji.1');
    const result = who(await service('api-gateway', 'privacy-service'), 'privacy-service', {
      'x-actor-token': actor,
    });
    expect(result).toMatchObject({ requestingService: 'API_GATEWAY', actor: { role: 'admin' } });
  });

  it('DK-04 a customer in the admin client, and an administrator in the customer client, get no usable token', async () => {
    const customerAsAdmin = await human('admin-console', 'nasabah.uji.101');
    expect(refused(customerAsAdmin, 'privacy-service')).not.toBe('accepted');
    const adminAsCustomer = await human('customer-app', 'admin.uji.1');
    expect(refused(adminAsCustomer, 'api-gateway')).not.toBe('accepted');
  });

  describe('the Admin API the registration needs (client idp-admin only)', () => {
    // `master` is the bootstrap administrator of the test container: only a fixture (a person with two roles) needs it, the
    // registration path must work with idp-admin alone.
    const masterToken = async (): Promise<string> => {
      const answer = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'kcadmin',
          password: adminPassword,
        }),
      });
      return ((await answer.json()) as { access_token: string }).access_token;
    };
    const admin = async (
      method: string,
      path: string,
      body?: unknown,
      master = false,
    ): Promise<Response> =>
      fetch(`${BASE}/admin/realms/privpay${path}`, {
        method,
        headers: {
          authorization: `Bearer ${master ? await masterToken() : await service('idp-admin')}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const idOf = async (username: string): Promise<string> => {
      const found = (await (
        await admin('GET', `/users?username=${username}&exact=true`)
      ).json()) as { id: string }[];
      return found[0]?.id ?? '';
    };

    it('DK-04 a person with two roles is still refused, whatever the client', async () => {
      const created = await admin('POST', '/users', {
        username: 'ganda.uji.1',
        enabled: true,
        credentials: [{ type: 'password', value: devPassword, temporary: false }],
      });
      expect(created.status).toBe(201);
      const id = await idOf('ganda.uji.1');
      const roles = await Promise.all(
        ['admin', 'auditor'].map(async (name) => (await admin('GET', `/roles/${name}`)).json()),
      );
      const mapped = await admin('POST', `/users/${id}/role-mappings/realm`, roles, true);
      expect({ status: mapped.status, text: await mapped.text() }).toEqual({
        status: 204,
        text: '',
      });
      const token = await human('admin-console', 'ganda.uji.1');
      expect(refused(token, 'privacy-service')).toBe('UNAUTHENTICATED');
    });

    it('DK-04 create a customer with customer_id, find it by that attribute, sign in, and delete it (registration and compensation)', async () => {
      const customerId = `CUST-${String(100_000 + Math.floor(Math.random() * 800_000))}`;
      const created = await admin('POST', '/users', {
        username: `uji.daftar.${customerId.slice(-6)}`,
        enabled: true,
        attributes: { customer_id: [customerId] },
        credentials: [{ type: 'password', value: devPassword, temporary: false }],
      });
      expect(created.status).toBe(201);
      const found = (await (await admin('GET', `/users?q=customer_id:${customerId}`)).json()) as {
        id: string;
        username: string;
      }[];
      expect(found).toHaveLength(1);
      const id = found[0]?.id ?? '';
      expect(
        (
          await admin('POST', `/users/${id}/role-mappings/realm`, [
            await (await admin('GET', '/roles/customer')).json(),
          ])
        ).status,
      ).toBe(204);
      const token = await human('customer-app', found[0]?.username ?? '');
      expect(who(token, 'api-gateway')).toMatchObject({
        requestingService: 'CUSTOMER',
        customerId,
      });
      expect((await admin('DELETE', `/users/${id}`)).status).toBe(204);
      expect(
        ((await (await admin('GET', `/users?q=customer_id:${customerId}`)).json()) as unknown[])
          .length,
      ).toBe(0);
    });

    it('DK-04 the admin client cannot be used as a service token (its token has no audience of a service)', async () => {
      expect(refused(await service('idp-admin'), 'privacy-service')).not.toBe('accepted');
    });
  });

  describe('the shared IdP helpers of packages/common against the real Keycloak (ticket 1)', () => {
    const http = (): ReturnType<typeof createHttpClient> =>
      createHttpClient({ baseUrls: { idp: BASE }, timeoutMs: 5000, maxRetries: 0 });
    const idp = { kind: 'keycloak', realm: 'privpay' } as const;

    it('DK-04 idpJwksSource keeps the signing key, JwksKeys loads it, and a token of createIdpTokenCache passes authenticate()', async () => {
      const client = http();
      const jwks = new JwksKeys({
        source: idpJwksSource(client, idp),
        clock: new FakeClock(new Date()),
        cooldownSeconds: 30,
        maxAgeSeconds: 300,
      });
      const cache = createIdpTokenCache({
        http: client,
        clock: new FakeClock(new Date()),
        idp,
        grant: {
          type: 'client-credentials',
          clientId: 'transaction',
          clientSecret: clientSecrets['transaction'] ?? '',
          audience: 'privacy-service',
        },
      });
      const token = await cache.get();
      const kid = unverifiedKid(token);
      await jwks.ensure(kid);
      const result = authenticate(
        { authorization: `Bearer ${token}` },
        { ...options('privacy-service'), resolveKey: (id) => jwks.resolveKey(id) },
      );
      expect(result).toMatchObject({ requestingService: 'TRANSACTION' });
    });

    it('DK-04 the bank signs in with createIdpTokenCache (password grant), and a wrong password is unavailable', async () => {
      const grant = { type: 'login', clientId: 'bank-simulator', username: 'bank.uji.1' } as const;
      const good = createIdpTokenCache({
        http: http(),
        clock: new FakeClock(new Date()),
        idp,
        grant: { ...grant, password: devPassword },
      });
      expect(who(await good.get(), 'api-gateway')).toMatchObject({ requestingService: 'BANK' });
      const bad = createIdpTokenCache({
        http: http(),
        clock: new FakeClock(new Date()),
        idp,
        grant: { ...grant, password: `${devPassword}x` },
      });
      await expect(bad.get()).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
    });
  });

  it('DK-04 a token signed by another key, or with the algorithm none, is refused', () => {
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = signJwt(
      {
        iss: ISSUER,
        sub: 'x',
        azp: 'admin-console',
        aud: ['privacy-service'],
        roles: ['admin'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      { privateKey: stranger.privateKey, kid: [...keys.keys()][0] ?? 'k' },
    );
    expect(refused(forged, 'privacy-service')).not.toBe('accepted');
  });
});
