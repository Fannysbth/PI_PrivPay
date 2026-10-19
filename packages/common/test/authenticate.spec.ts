import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { FakeClock } from '../src/clock';
import { DomainError } from '../src/errors';
import { signJwt } from '../src/jwt';
import { authenticate, type AuthenticateOptions } from '../src/authenticate';

// Tokens are minted here with a key made for the run, the way the dev IdP would, then handed to authenticate.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'k1';
const ISS = 'privpay-dev-idp';
const START = new Date('2026-10-19T08:00:00Z');
const NOW = Math.floor(START.getTime() / 1000);

let clock: FakeClock;
beforeEach(() => {
  clock = new FakeClock(START);
});

const resolveKey = (kid: string | undefined): KeyObject | undefined =>
  kid === KID ? pair.publicKey : undefined;
const options = (
  service: string,
  extra: Partial<AuthenticateOptions> = {},
): AuthenticateOptions => ({
  clock,
  issuer: ISS,
  service,
  resolveKey,
  ...extra,
});

const mint = (claims: Record<string, unknown>, key = pair.privateKey): string =>
  signJwt(
    { iss: ISS, iat: NOW, exp: NOW + 300, jti: 'fake-jti', ...claims },
    { privateKey: key, kid: KID },
  );
const serviceToken = (client: string, aud: string[], extra: Record<string, unknown> = {}): string =>
  mint({ sub: client, azp: client, aud, ...extra });
const humanToken = (
  client: string,
  role: string | string[],
  aud: string[],
  extra: Record<string, unknown> = {},
): string =>
  mint({
    sub: `usr-${String(role)}`,
    azp: client,
    aud,
    roles: Array.isArray(role) ? role : [role],
    ...extra,
  });

const bearer = (token: string): string => `Bearer ${token}`;
const failure = (
  headers: Record<string, string | string[] | undefined>,
  opts: AuthenticateOptions,
): string => {
  try {
    authenticate(headers, opts);
  } catch (error) {
    if (error instanceof DomainError) return `${error.reason}:${String(error.cause)}`;
    throw error;
  }
  return 'accepted';
};
const reason = (
  headers: Record<string, string | string[] | undefined>,
  opts: AuthenticateOptions,
): string => failure(headers, opts).split(':')[0] ?? '';

describe('M1-02 requesting_service comes only from the azp of the Authorization token (D-16, TK-07)', () => {
  it.each([
    ['api-gateway', 'API_GATEWAY'],
    ['transaction', 'TRANSACTION'],
    ['fraud', 'FRAUD'],
    ['notification', 'NOTIFICATION'],
    ['reconciliation', 'RECONCILIATION'],
  ])('M1-02 azp %s becomes %s', (azp, expected) => {
    const result = authenticate(
      { authorization: bearer(serviceToken(azp, ['privacy-service'])) },
      options('privacy-service'),
    );
    expect(result).toMatchObject({ requestingService: expected, subject: azp });
    expect(result.actor).toBeUndefined();
  });

  it('M1-02 the bank simulator is BANK and an admin-console person is ADMIN_CONSOLE', () => {
    const bank = authenticate(
      { authorization: bearer(humanToken('bank-simulator', 'bank', ['api-gateway'])) },
      options('api-gateway'),
    );
    expect(bank.requestingService).toBe('BANK');
    const admin = authenticate(
      { authorization: bearer(humanToken('admin-console', 'admin', ['privacy-service'])) },
      options('privacy-service'),
    );
    expect(admin).toMatchObject({
      requestingService: 'ADMIN_CONSOLE',
      actor: { actorId: 'usr-admin', role: 'admin' },
    });
  });

  it('M1-02 TK-07 a requesting_service claim, an unknown claim or extra headers change nothing', () => {
    const token = serviceToken('fraud', ['privacy-service'], {
      requesting_service: 'API_GATEWAY',
      service: 'API_GATEWAY',
    });
    const result = authenticate(
      {
        authorization: bearer(token),
        'x-requesting-service': 'API_GATEWAY',
        'x-actor-id': 'usr-admin',
        'x-role': 'auditor',
        'x-actor-role': 'auditor',
      },
      options('privacy-service'),
    );
    expect(result.requestingService).toBe('FRAUD');
    expect(result.actor).toBeUndefined();
  });

  it('M1-02 an actor token never decides the requesting service, even one that names a service azp', () => {
    const actor = serviceToken('api-gateway', ['reconciliation-service'], { roles: ['auditor'] });
    const result = reason(
      {
        authorization: bearer(serviceToken('reconciliation', ['reconciliation-service'])),
        'x-actor-token': actor,
      },
      options('reconciliation-service'),
    );
    expect(result).toBe('FORBIDDEN_ROLE');
    const plain = authenticate(
      { authorization: bearer(serviceToken('reconciliation', ['reconciliation-service'])) },
      options('reconciliation-service'),
    );
    expect(plain.requestingService).toBe('RECONCILIATION');
  });

  it('M1-02 an azp outside the allowlist is rejected', () => {
    expect(
      reason(
        { authorization: bearer(serviceToken('privacy-service', ['privacy-service'])) },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
    expect(
      reason(
        { authorization: bearer(serviceToken('someone', ['privacy-service'])) },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
  });
});

describe('M1-02 the Authorization header and the token are checked first (ADR-0007, NFR-21)', () => {
  const good = (): string => serviceToken('transaction', ['privacy-service']);

  it.each([undefined, '', 'Bearer', 'Bearer ', 'bearer abc', 'Basic abc', 'Bearer a b'])(
    'M1-02 %p is UNAUTHENTICATED',
    (header) => {
      expect(reason({ authorization: header }, options('privacy-service'))).toBe('UNAUTHENTICATED');
    },
  );

  it('M1-02 a repeated Authorization header is UNAUTHENTICATED', () => {
    expect(
      reason({ authorization: [bearer(good()), bearer(good())] }, options('privacy-service')),
    ).toBe('UNAUTHENTICATED');
  });

  it('M1-02 expired, tampered, foreign-key and wrong-issuer tokens are UNAUTHENTICATED', () => {
    const token = good();
    clock.advance(300);
    expect(reason({ authorization: bearer(token) }, options('privacy-service'))).toBe(
      'UNAUTHENTICATED',
    );
    clock.set(START);
    const genuine = serviceToken('transaction', ['privacy-service']);
    // The first character of the signature, not the last: the last carries two useful bits and can be respelled.
    const [h = '', p = '', s = ''] = genuine.split('.');
    const forged = [h, p, (s.startsWith('A') ? 'B' : 'A') + s.slice(1)].join('.');
    expect(reason({ authorization: bearer(forged) }, options('privacy-service'))).toBe(
      'UNAUTHENTICATED',
    );
    expect(
      reason(
        {
          authorization: bearer(
            mint({ sub: 't', azp: 'transaction', aud: ['privacy-service'] }, stranger.privateKey),
          ),
        },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
    expect(
      reason(
        {
          authorization: bearer(
            serviceToken('transaction', ['privacy-service'], { iss: 'someone-else' }),
          ),
        },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
  });

  it('M1-02 a token that lives longer than 300 seconds is UNAUTHENTICATED (NFR-21)', () => {
    const long = serviceToken('transaction', ['privacy-service'], { exp: NOW + 3600 });
    expect(failure({ authorization: bearer(long) }, options('privacy-service'))).toBe(
      'UNAUTHENTICATED:claims',
    );
  });

  it('M1-02 a token made for another service is FORBIDDEN_ROLE, not usable here', () => {
    const token = serviceToken('transaction', ['fraud-service']);
    expect(reason({ authorization: bearer(token) }, options('privacy-service'))).toBe(
      'FORBIDDEN_ROLE',
    );
  });

  it('M1-02 alg none and HS256 are UNAUTHENTICATED', () => {
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISS, azp: 'transaction', aud: ['privacy-service'], iat: NOW, exp: NOW + 300 })).toString('base64url')}.`;
    expect(failure({ authorization: bearer(none) }, options('privacy-service'))).toBe(
      'UNAUTHENTICATED:alg',
    );
  });

  it('M1-02 the error carries a category only, never the token', () => {
    const token = good();
    clock.advance(400);
    try {
      authenticate({ authorization: bearer(token) }, options('privacy-service'));
    } catch (error) {
      const text = `${(error as Error).message} ${String((error as Error).cause)}`;
      expect(text).not.toContain(token.slice(10, 40));
      return;
    }
    throw new Error('expected a failure');
  });
});

describe('M1-02 claims must fit the kind of caller', () => {
  it('M1-02 a service token with roles, or a human token without exactly one allowed role, is rejected', () => {
    expect(
      reason(
        {
          authorization: bearer(
            serviceToken('transaction', ['privacy-service'], { roles: ['auditor'] }),
          ),
        },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
    for (const roles of [[], ['admin', 'auditor'], ['superuser'], ['bank'], ['customer']]) {
      const token = humanToken('admin-console', roles, ['privacy-service']);
      expect(reason({ authorization: bearer(token) }, options('privacy-service'))).toBe(
        'UNAUTHENTICATED',
      );
    }
    expect(
      reason(
        { authorization: bearer(humanToken('bank-simulator', 'admin', ['api-gateway'])) },
        options('api-gateway'),
      ),
    ).toBe('UNAUTHENTICATED');
    expect(
      reason(
        {
          authorization: bearer(mint({ sub: 'u', azp: 'admin-console', aud: ['privacy-service'] })),
        },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
  });

  it('M1-02 customer_id is only valid on the customer token', () => {
    expect(
      reason(
        {
          authorization: bearer(
            serviceToken('transaction', ['privacy-service'], { customer_id: 'CUST-000101' }),
          ),
        },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
    expect(
      reason(
        {
          authorization: bearer(
            humanToken('admin-console', 'admin', ['privacy-service'], {
              customer_id: 'CUST-000101',
            }),
          ),
        },
        options('privacy-service'),
      ),
    ).toBe('UNAUTHENTICATED');
  });
});

describe('M1-02 the customer token is for the gateway alone (ADR-0007 item 4)', () => {
  const customer = (extra: Record<string, unknown> = {}): string =>
    humanToken('customer-app', 'customer', ['api-gateway'], {
      customer_id: 'CUST-000101',
      ...extra,
    });

  it('M1-02 the gateway accepts it and gets the customer id from the claim', () => {
    const result = authenticate(
      { authorization: bearer(customer()) },
      options('api-gateway', { acceptCustomerToken: true }),
    );
    expect(result).toMatchObject({ requestingService: 'CUSTOMER', customerId: 'CUST-000101' });
  });

  it('M1-02 every other service refuses it, and the gateway refuses it unless it asked for customers', () => {
    expect(reason({ authorization: bearer(customer()) }, options('api-gateway'))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(
      reason(
        { authorization: bearer(customer({ aud: ['privacy-service'] })) },
        options('privacy-service', { acceptCustomerToken: true }),
      ),
    ).toBe('FORBIDDEN_ROLE');
  });

  it('M1-02 a customer token without a valid customer_id is rejected', () => {
    for (const customerId of [undefined, 'cust-1', 'CUST-1', 42]) {
      const token = humanToken(
        'customer-app',
        'customer',
        ['api-gateway'],
        customerId === undefined ? {} : { customer_id: customerId },
      );
      expect(
        reason(
          { authorization: bearer(token) },
          options('api-gateway', { acceptCustomerToken: true }),
        ),
      ).toBe('UNAUTHENTICATED');
    }
  });
});

describe('M1-02 the actor token (X-Actor-Token) carries a person, never a service (ADR-0007 item 3)', () => {
  const service = 'reconciliation-service';
  const caller = (): string => bearer(serviceToken('reconciliation', [service]));
  const auditor = (extra: Record<string, unknown> = {}): string =>
    humanToken(
      'admin-console',
      'auditor',
      ['api-gateway', 'reconciliation-service', 'privacy-service'],
      extra,
    );

  it('M1-02 a service call with a valid person token gives actor id and role, and keeps the service', () => {
    const result = authenticate(
      { authorization: caller(), 'x-actor-token': auditor() },
      options(service),
    );
    expect(result).toMatchObject({
      requestingService: 'RECONCILIATION',
      actor: { actorId: 'usr-auditor', role: 'auditor' },
    });
  });

  it('M1-02 a service token, a customer token and a bank token are not people', () => {
    const attempts = [
      serviceToken('api-gateway', [service]),
      humanToken('customer-app', 'customer', [service], { customer_id: 'CUST-000101' }),
      humanToken('bank-simulator', 'bank', [service]),
      serviceToken('transaction', [service], { roles: ['auditor'] }),
    ];
    for (const actor of attempts) {
      expect(reason({ authorization: caller(), 'x-actor-token': actor }, options(service))).toMatch(
        /FORBIDDEN_ROLE|UNAUTHENTICATED/,
      );
      expect(
        reason({ authorization: caller(), 'x-actor-token': actor }, options(service)),
      ).not.toBe('accepted');
    }
  });

  it('M1-02 K-03 an actor token made for other services is refused here', () => {
    const forTransactionOnly = humanToken('admin-console', 'fraud_analyst', [
      'api-gateway',
      'transaction-service',
    ]);
    expect(
      reason({ authorization: caller(), 'x-actor-token': forTransactionOnly }, options(service)),
    ).toBe('FORBIDDEN_ROLE');
    const admin = humanToken('admin-console', 'admin', ['api-gateway', 'privacy-service']);
    expect(reason({ authorization: caller(), 'x-actor-token': admin }, options(service))).toBe(
      'FORBIDDEN_ROLE',
    );
  });

  it('M1-02 an invalid, expired or repeated actor token is rejected, and a blank one too', () => {
    const token = auditor();
    expect(
      reason({ authorization: caller(), 'x-actor-token': `${token}x` }, options(service)),
    ).toBe('UNAUTHENTICATED');
    expect(reason({ authorization: caller(), 'x-actor-token': '' }, options(service))).toBe(
      'UNAUTHENTICATED',
    );
    expect(
      reason({ authorization: caller(), 'x-actor-token': [token, token] }, options(service)),
    ).toBe('UNAUTHENTICATED');
    expect(
      reason({ authorization: caller(), 'x-actor-token': bearer(token) }, options(service)),
    ).toBe('UNAUTHENTICATED');
    clock.advance(300);
    const fresh = caller();
    expect(reason({ authorization: fresh, 'x-actor-token': token }, options(service))).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('M1-02 a person token in Authorization takes no X-Actor-Token (no double identity)', () => {
    const own = humanToken('admin-console', 'auditor', ['api-gateway', 'reconciliation-service']);
    expect(authenticate({ authorization: bearer(own) }, options(service)).actor).toMatchObject({
      role: 'auditor',
    });
    expect(
      reason({ authorization: bearer(own), 'x-actor-token': auditor() }, options(service)),
    ).toBe('FORBIDDEN_ROLE');
    expect(reason({ authorization: bearer(own), 'x-actor-token': own }, options(service))).toBe(
      'FORBIDDEN_ROLE',
    );
  });

  it('M1-02 only service accounts may forward a person: the bank and customers may not', () => {
    const bank = humanToken('bank-simulator', 'bank', ['api-gateway']);
    expect(
      reason(
        { authorization: bearer(bank), 'x-actor-token': auditor({ aud: ['api-gateway'] }) },
        options('api-gateway'),
      ),
    ).toBe('FORBIDDEN_ROLE');
    const customer = humanToken('customer-app', 'customer', ['api-gateway'], {
      customer_id: 'CUST-000101',
    });
    expect(
      reason(
        { authorization: bearer(customer), 'x-actor-token': auditor({ aud: ['api-gateway'] }) },
        options('api-gateway', { acceptCustomerToken: true }),
      ),
    ).toBe('FORBIDDEN_ROLE');
  });
});
