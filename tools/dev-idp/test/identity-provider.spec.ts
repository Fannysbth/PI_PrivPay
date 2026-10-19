import nodeCrypto, { createPublicKey, type KeyObject } from 'node:crypto';
import { FakeClock, DomainError, verifyJwt } from '@privpay/common';
import { IdentityProvider, type TokenRequest } from '../src/identity-provider';
import { DEFAULT_REGISTRY, ISSUER, type Registry } from '../src/registry';
import { loadSeedUsers, SEED_FILE } from '../src/seed';

// Fake secrets, made up for the test run.
const SECRETS = {
  'api-gateway': 'fake-secret-api-gateway',
  transaction: 'fake-secret-transaction',
  fraud: 'fake-secret-fraud',
  notification: 'fake-secret-notification',
  reconciliation: 'fake-secret-reconciliation',
};
const START = new Date('2026-10-19T08:00:00Z');
const NOW = Math.floor(START.getTime() / 1000);

let clock: FakeClock;
const make = (override: { ttlSeconds?: number; registry?: Registry } = {}): IdentityProvider =>
  new IdentityProvider({
    clock,
    ttlSeconds: override.ttlSeconds ?? 300,
    serviceSecrets: SECRETS,
    users: loadSeedUsers(SEED_FILE),
    registry: override.registry ?? DEFAULT_REGISTRY,
  });

/** Verifies a token the way a receiving service would, through the published JWKS only. */
const verifyFor = (
  idp: IdentityProvider,
  token: string,
  audience: string,
): Record<string, unknown> => {
  const keys = new Map<string, KeyObject>(
    idp.jwks().keys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })]),
  );
  return verifyJwt(token, {
    clock,
    issuer: ISSUER,
    audience,
    resolveKey: (kid) => (kid ? keys.get(kid) : undefined),
  });
};
const reasonOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error.reason;
    throw error;
  }
  return 'no error';
};
const service = (
  client: keyof typeof SECRETS,
  audience: string[],
  secret = SECRETS[client],
): TokenRequest => ({
  grant_type: 'client_credentials',
  client_id: client,
  client_secret: secret,
  audience,
});
const login = (client: string, username: string): TokenRequest => ({
  grant_type: 'dev_login',
  client_id: client,
  username,
});

beforeEach(() => {
  clock = new FakeClock(START);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('M1-01 client_credentials issues a service token (ADR-0007, NFR-21)', () => {
  it('M1-01 the token verifies through the JWKS and carries iss, sub, azp, aud, iat, exp and jti', () => {
    const idp = make();
    const response = idp.token(service('transaction', ['privacy-service', 'fraud-service']));
    expect(response).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    const claims = verifyFor(idp, response.access_token, 'fraud-service');
    expect(claims).toMatchObject({
      iss: 'privpay-dev-idp',
      sub: 'transaction',
      azp: 'transaction',
      aud: ['privacy-service', 'fraud-service'],
      iat: NOW,
      exp: NOW + 300,
    });
    expect(claims['jti']).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims['roles']).toBeUndefined();
    expect(claims['customer_id']).toBeUndefined();
  });

  it('M1-01 the issuer says dev, so a dev token cannot pass for a real one (NFR-21)', () => {
    expect(ISSUER).toContain('dev');
  });

  it('M1-01 lives at most 300 seconds, and an older token is expired', () => {
    const idp = make({ ttlSeconds: 120 });
    const { access_token: token, expires_in: lifetime } = idp.token(
      service('fraud', ['privacy-service']),
    );
    expect(lifetime).toBe(120);
    clock.advance(119);
    expect(verifyFor(idp, token, 'privacy-service')).toBeDefined();
    clock.advance(1);
    expect(() => verifyFor(idp, token, 'privacy-service')).toThrow(DomainError);
  });

  it.each([0, 301, 1.5, Number.NaN])(
    'M1-01 refuses a token lifetime of %s seconds',
    (ttlSeconds) => {
      expect(() => make({ ttlSeconds })).toThrow(RangeError);
    },
  );

  it('M1-01 a wrong secret, an unknown client and a human client all get the same UNAUTHENTICATED', () => {
    const idp = make();
    expect(reasonOf(() => idp.token(service('transaction', ['privacy-service'], 'wrong')))).toBe(
      'UNAUTHENTICATED',
    );
    expect(reasonOf(() => idp.token(service('transaction', ['privacy-service'], '')))).toBe(
      'UNAUTHENTICATED',
    );
    expect(
      reasonOf(() =>
        idp.token({
          grant_type: 'client_credentials',
          client_id: 'nobody',
          client_secret: 'x',
          audience: ['privacy-service'],
        }),
      ),
    ).toBe('UNAUTHENTICATED');
    expect(
      reasonOf(() =>
        idp.token({
          grant_type: 'client_credentials',
          client_id: 'admin-console',
          client_secret: 'x',
          audience: ['api-gateway'],
        }),
      ),
    ).toBe('UNAUTHENTICATED');
  });

  it('M1-01 the client secret check calls timingSafeEqual once, also when the client is unknown', () => {
    const idp = make();
    const spy = jest.spyOn(nodeCrypto, 'timingSafeEqual');
    reasonOf(() => idp.token(service('fraud', ['privacy-service'], 'fake-secret-fraux')));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    reasonOf(() =>
      idp.token({
        grant_type: 'client_credentials',
        client_id: 'nobody',
        client_secret: 'fake-secret-fraud',
        audience: ['privacy-service'],
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('M1-01 an audience the client may not ask for, or none at all, is refused (FORBIDDEN_ROLE)', () => {
    const idp = make();
    expect(reasonOf(() => idp.token(service('fraud', ['transaction-service'])))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(reasonOf(() => idp.token(service('fraud', ['privacy-service', 'dev-idp'])))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(reasonOf(() => idp.token(service('fraud', [])))).toBe('FORBIDDEN_ROLE');
  });

  it('M1-01 the notification service may ask for a token for the sms simulator (AZ-41)', () => {
    const idp = make();
    expect(
      reasonOf(() => idp.token(service('notification', ['privacy-service', 'sms-simulator']))),
    ).toBe('no error');
    expect(reasonOf(() => idp.token(service('fraud', ['sms-simulator'])))).toBe('FORBIDDEN_ROLE');
  });

  it('M1-01 only the gateway may ask for a token for the dev IdP itself', () => {
    const idp = make();
    expect(reasonOf(() => idp.token(service('api-gateway', ['dev-idp'])))).toBe('no error');
    for (const client of ['transaction', 'fraud', 'notification', 'reconciliation'] as const) {
      expect(reasonOf(() => idp.token(service(client, ['dev-idp'])))).toBe('FORBIDDEN_ROLE');
    }
  });
});

describe('M1-01 dev_login issues a human token for a seed user (ADR-0007 items 5, 6, 8)', () => {
  const cases: [string, string, string, string[]][] = [
    ['customer-app', 'nasabah.uji.101', 'customer', ['api-gateway']],
    ['admin-console', 'admin.uji.1', 'admin', ['api-gateway', 'privacy-service']],
    [
      'admin-console',
      'auditor.uji.1',
      'auditor',
      ['api-gateway', 'reconciliation-service', 'privacy-service'],
    ],
    ['admin-console', 'analis.uji.1', 'fraud_analyst', ['api-gateway', 'transaction-service']],
    ['bank-simulator', 'bank.uji.1', 'bank', ['api-gateway']],
  ];

  it.each(cases)(
    'M1-01 %s signs in %s with exactly the role %s and the audiences of that role',
    (client, username, role, audience) => {
      const idp = make();
      const { access_token: token } = idp.token(login(client, username));
      const claims = verifyFor(idp, token, 'api-gateway');
      expect(claims).toMatchObject({
        iss: ISSUER,
        azp: client,
        aud: audience,
        roles: [role],
        exp: NOW + 300,
      });
      expect(String(claims['sub'])).toMatch(/^usr-/);
    },
  );

  it('M1-01 only the customer token carries customer_id, and it is the seed value', () => {
    const idp = make();
    const customer = verifyFor(
      idp,
      idp.token(login('customer-app', 'nasabah.uji.102')).access_token,
      'api-gateway',
    );
    expect(customer['customer_id']).toBe('CUST-000102');
    for (const [client, username] of [
      ['admin-console', 'admin.uji.2'],
      ['bank-simulator', 'bank.uji.1'],
    ] as const) {
      const claims = verifyFor(idp, idp.token(login(client, username)).access_token, 'api-gateway');
      expect(claims['customer_id']).toBeUndefined();
    }
  });

  it('M1-01 every seed user signs in with its own client only: any other client, and any unknown name, is UNAUTHENTICATED', () => {
    const idp = make();
    expect(reasonOf(() => idp.token(login('customer-app', 'admin.uji.1')))).toBe('UNAUTHENTICATED');
    expect(reasonOf(() => idp.token(login('admin-console', 'nasabah.uji.101')))).toBe(
      'UNAUTHENTICATED',
    );
    expect(reasonOf(() => idp.token(login('bank-simulator', 'auditor.uji.1')))).toBe(
      'UNAUTHENTICATED',
    );
    expect(reasonOf(() => idp.token(login('admin-console', 'nobody.uji.9')))).toBe(
      'UNAUTHENTICATED',
    );
    expect(reasonOf(() => idp.token(login('api-gateway', 'admin.uji.1')))).toBe('UNAUTHENTICATED');
    expect(reasonOf(() => idp.token(login('transaction', 'admin.uji.1')))).toBe('UNAUTHENTICATED');
  });

  it('M1-01 every human token holds exactly one role', () => {
    const idp = make();
    for (const user of loadSeedUsers(SEED_FILE)) {
      const client =
        user.role === 'customer'
          ? 'customer-app'
          : user.role === 'bank'
            ? 'bank-simulator'
            : 'admin-console';
      const claims = verifyFor(
        idp,
        idp.token(login(client, user.username)).access_token,
        'api-gateway',
      );
      expect(claims['roles']).toEqual([user.role]);
    }
  });
});

describe('M1-01 the signing key is made at start and published as a JWKS (ADR-0004)', () => {
  it('M1-01 the JWKS holds one RS256 signature key and no private member', () => {
    const { keys } = make().jwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(Object.keys(keys[0] ?? {}).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });

  it('M1-01 each start makes a new key, so nothing about the key is stored or shared between runs', () => {
    expect(make().jwks().keys[0]?.n).not.toBe(make().jwks().keys[0]?.n);
  });

  it('M1-01 a token from one instance does not verify against another one', () => {
    const first = make();
    const second = make();
    const { access_token: token } = first.token(service('fraud', ['privacy-service']));
    expect(() => verifyFor(second, token, 'privacy-service')).toThrow(DomainError);
  });
});

describe('M1-01 the admin API creates and removes customers for the gateway only (AZ-38, AZ-39)', () => {
  const gatewayToken = (idp: IdentityProvider): string =>
    idp.token(service('api-gateway', ['dev-idp'])).access_token;

  it('M1-01 authenticateAdmin accepts the gateway token made for the dev IdP', () => {
    const idp = make();
    expect(() => idp.authenticateAdmin(`Bearer ${gatewayToken(idp)}`)).not.toThrow();
  });

  it('M1-01 N1: no token, a malformed header and a bad token are UNAUTHENTICATED', () => {
    const idp = make();
    const token = gatewayToken(idp);
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Basic abc',
      token,
      `Bearer ${token}x`,
    ]) {
      expect(reasonOf(() => idp.authenticateAdmin(header))).toBe('UNAUTHENTICATED');
    }
  });

  it('M1-01 N2: a valid token made for another audience is FORBIDDEN_ROLE, a valid caller that may not use this API', () => {
    const idp = make();
    const wrong = idp.token(service('api-gateway', ['privacy-service'])).access_token;
    expect(reasonOf(() => idp.authenticateAdmin(`Bearer ${wrong}`))).toBe('FORBIDDEN_ROLE');
    const human = idp.token(login('customer-app', 'nasabah.uji.101')).access_token;
    expect(reasonOf(() => idp.authenticateAdmin(`Bearer ${human}`))).toBe('FORBIDDEN_ROLE');
  });

  it('M1-01 N3: a valid token of another service client is FORBIDDEN_ROLE even if the registry let it ask for dev-idp', () => {
    // The registry never gives anyone but the gateway this audience; the azp check must still hold on its own.
    const widened: Registry = {
      ...DEFAULT_REGISTRY,
      serviceAudiences: {
        ...DEFAULT_REGISTRY.serviceAudiences,
        transaction: ['privacy-service', 'dev-idp'],
      },
    };
    const idp = make({ registry: widened });
    const token = idp.token(service('transaction', ['dev-idp'])).access_token;
    expect(reasonOf(() => idp.authenticateAdmin(`Bearer ${token}`))).toBe('FORBIDDEN_ROLE');
  });

  it('M1-01 N4: a human token is FORBIDDEN_ROLE even if its role were allowed the dev IdP audience', () => {
    const widened: Registry = {
      ...DEFAULT_REGISTRY,
      roleAudiences: { ...DEFAULT_REGISTRY.roleAudiences, admin: ['api-gateway', 'dev-idp'] },
    };
    const idp = make({ registry: widened });
    const token = idp.token(login('admin-console', 'admin.uji.1')).access_token;
    expect(reasonOf(() => idp.authenticateAdmin(`Bearer ${token}`))).toBe('FORBIDDEN_ROLE');
  });

  it('M1-01 an expired gateway token is UNAUTHENTICATED', () => {
    const idp = make();
    const token = gatewayToken(idp);
    clock.advance(300);
    expect(reasonOf(() => idp.authenticateAdmin(`Bearer ${token}`))).toBe('UNAUTHENTICATED');
  });

  it('M1-01 createCustomer gives the next CUST number after the seed, and the new user can sign in', () => {
    const idp = make();
    const first = idp.createCustomer('nasabah.uji.104');
    const second = idp.createCustomer('nasabah.uji.105');
    expect([first.customer_id, second.customer_id]).toEqual(['CUST-000104', 'CUST-000105']);
    const claims = verifyFor(
      idp,
      idp.token(login('customer-app', 'nasabah.uji.104')).access_token,
      'api-gateway',
    );
    expect(claims).toMatchObject({
      sub: first.id,
      roles: ['customer'],
      customer_id: 'CUST-000104',
    });
  });

  it('M1-01 a username that is taken, by a seed user or a created one, is VALIDATION_ERROR', () => {
    const idp = make();
    expect(reasonOf(() => idp.createCustomer('nasabah.uji.101'))).toBe('VALIDATION_ERROR');
    expect(reasonOf(() => idp.createCustomer('admin.uji.1'))).toBe('VALIDATION_ERROR');
    idp.createCustomer('nasabah.uji.200');
    expect(reasonOf(() => idp.createCustomer('nasabah.uji.200'))).toBe('VALIDATION_ERROR');
  });

  it('M1-01 deleteCustomer removes a created user, is a no-op for an unknown id, and refuses a seed user', () => {
    const idp = make();
    const created = idp.createCustomer('nasabah.uji.300');
    idp.deleteCustomer(created.customer_id);
    expect(reasonOf(() => idp.token(login('customer-app', 'nasabah.uji.300')))).toBe(
      'UNAUTHENTICATED',
    );
    expect(reasonOf(() => idp.deleteCustomer(created.customer_id))).toBe('no error');
    expect(reasonOf(() => idp.deleteCustomer('CUST-009999'))).toBe('no error');
    expect(reasonOf(() => idp.deleteCustomer('CUST-000101'))).toBe('VALIDATION_ERROR');
  });

  it('M1-01 a deleted number is not handed out again', () => {
    const idp = make();
    const first = idp.createCustomer('nasabah.uji.400');
    idp.deleteCustomer(first.customer_id);
    expect(idp.createCustomer('nasabah.uji.401').customer_id).toBe('CUST-000105');
  });
});
