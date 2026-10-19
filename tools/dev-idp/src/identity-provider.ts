import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { DomainError, safeEqual, signJwt, verifyJwt, type Clock } from '@privpay/common';
import {
  DEFAULT_REGISTRY,
  DEV_IDP_AUDIENCE,
  ISSUER,
  SERVICE_CLIENTS,
  type HumanClient,
  type Registry,
  type ServiceClient,
} from './registry';
import { USERNAME, type SeedUser } from './seed';

export type TokenRequest =
  | {
      readonly grant_type: 'client_credentials';
      readonly client_id: string;
      readonly client_secret: string;
      readonly audience: readonly string[];
    }
  | { readonly grant_type: 'dev_login'; readonly client_id: string; readonly username: string };

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
}

export type Jwk = {
  readonly kty: 'RSA';
  readonly n: string;
  readonly e: string;
  readonly alg: 'RS256';
  readonly use: 'sig';
  readonly kid: string;
};

export interface CreatedCustomer {
  readonly id: string;
  readonly customer_id: string;
  readonly username: string;
}

export interface IdentityProviderOptions {
  readonly clock: Clock;
  /** Token lifetime in seconds; 1 to 300 (NFR-21). */
  readonly ttlSeconds: number;
  readonly serviceSecrets: Readonly<Record<ServiceClient, string>>;
  readonly users: readonly SeedUser[];
  readonly registry?: Registry;
}

const MAX_TTL_SECONDS = 300;
const CUSTOMER_ID = /^CUST-([0-9]{6})$/;
const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;
const CUSTOMER_CLIENT: HumanClient = 'customer-app';
const GATEWAY: ServiceClient = 'api-gateway';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const pad = (n: number): string => String(n).padStart(6, '0');
const hasOwn = (object: object, key: string): boolean => Object.hasOwn(object, key);

/**
 * The fake issuer of the local phase: it signs RS256 tokens with a key made at construction (never stored), knows the
 * clients and the seed users of ADR-0007, and runs the admin operations the Gateway needs to register a customer.
 * Everything lives in memory: a restart is a clean slate. No HTTP in here, so every rule is tested directly.
 */
export class IdentityProvider {
  private readonly clock: Clock;
  private readonly ttl: number;
  private readonly registry: Registry;
  private readonly serviceSecrets: Readonly<Record<ServiceClient, string>>;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly kid: string;
  private readonly jwk: Jwk;
  /** Compared against when the client is unknown, so a wrong client costs as much time as a wrong secret. */
  private readonly decoy = digest(randomUUID());
  private readonly byUsername = new Map<string, SeedUser>();
  private readonly seedCustomerIds = new Set<string>();
  private readonly createdCustomerIds = new Set<string>();
  private nextCustomerNumber: number;

  constructor(options: IdentityProviderOptions) {
    const { ttlSeconds } = options;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
      throw new RangeError(
        `token lifetime must be a whole number of seconds from 1 to ${String(MAX_TTL_SECONDS)}`,
      );
    }
    this.clock = options.clock;
    this.ttl = ttlSeconds;
    this.registry = options.registry ?? DEFAULT_REGISTRY;
    this.serviceSecrets = options.serviceSecrets;

    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.kid = createHash('sha256')
      .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64url')
      .slice(0, 16);
    const exported = pair.publicKey.export({ format: 'jwk' });
    this.jwk = {
      kty: 'RSA',
      n: String(exported.n),
      e: String(exported.e),
      alg: 'RS256',
      use: 'sig',
      kid: this.kid,
    };

    let highest = 0;
    for (const user of options.users) {
      this.byUsername.set(user.username, user);
      const match = user.customer_id === undefined ? null : CUSTOMER_ID.exec(user.customer_id);
      if (user.customer_id !== undefined && match?.[1] !== undefined) {
        this.seedCustomerIds.add(user.customer_id);
        highest = Math.max(highest, Number(match[1]));
      }
    }
    // Numbers continue after the seed (CUST-000101..103), so a created customer never reuses one.
    this.nextCustomerNumber = Math.max(highest, 100) + 1;
  }

  jwks(): { keys: Jwk[] } {
    return { keys: [this.jwk] };
  }

  token(request: TokenRequest): TokenResponse {
    return request.grant_type === 'client_credentials'
      ? this.serviceToken(request)
      : this.humanToken(request);
  }

  /**
   * Authorises a call to the admin API (AZ-38, AZ-39): a valid, unexpired token made for the dev IdP and issued to the
   * gateway's service account. Another client, or a token with roles (a human), is refused even when the audience was
   * somehow granted to it.
   */
  authenticateAdmin(authorization: string | undefined): { client: ServiceClient } {
    const token = authorization === undefined ? null : BEARER.exec(authorization)?.[1];
    if (token === null || token === undefined)
      throw new DomainError('UNAUTHENTICATED', 'no_bearer');
    let claims: Record<string, unknown>;
    try {
      claims = verifyJwt(token, {
        clock: this.clock,
        issuer: ISSUER,
        audience: DEV_IDP_AUDIENCE,
        resolveKey: (kid) => (kid === this.kid ? this.publicKey : undefined),
      });
    } catch (error) {
      // A token that is genuine but made for another audience belongs to a caller who is known and not allowed (403);
      // verifyJwt checks the audience last, so this is only reached by a token that passed everything else.
      if (error instanceof DomainError && error.cause === 'audience') {
        throw new DomainError('FORBIDDEN_ROLE', 'audience');
      }
      throw error;
    }
    if (claims['azp'] !== GATEWAY || claims['roles'] !== undefined) {
      throw new DomainError('FORBIDDEN_ROLE', 'not_gateway');
    }
    return { client: GATEWAY };
  }

  createCustomer(username: string): CreatedCustomer {
    if (!USERNAME.test(username) || this.byUsername.has(username)) {
      throw new DomainError('VALIDATION_ERROR', 'username');
    }
    const number = this.nextCustomerNumber;
    if (number > 999_999) throw new RangeError('customer numbers are used up');
    this.nextCustomerNumber += 1;
    const customerId = `CUST-${pad(number)}`;
    const user: SeedUser = {
      id: `usr-cust-${pad(number)}`,
      username,
      role: 'customer',
      customer_id: customerId,
    };
    this.byUsername.set(username, user);
    this.createdCustomerIds.add(customerId);
    return { id: user.id, customer_id: customerId, username };
  }

  /**
   * Idempotent, because the registration compensation may run twice (ADR-0005): true when a user was removed, false
   * when there was none. Seed users cannot be deleted.
   */
  deleteCustomer(customerId: string): boolean {
    if (!CUSTOMER_ID.test(customerId) || this.seedCustomerIds.has(customerId)) {
      throw new DomainError('VALIDATION_ERROR', 'customer_id');
    }
    if (!this.createdCustomerIds.delete(customerId)) return false;
    for (const [username, user] of this.byUsername) {
      if (user.customer_id === customerId) this.byUsername.delete(username);
    }
    return true;
  }

  private serviceToken(
    request: Extract<TokenRequest, { grant_type: 'client_credentials' }>,
  ): TokenResponse {
    const known = (SERVICE_CLIENTS as readonly string[]).includes(request.client_id);
    const expected = known
      ? digest(this.serviceSecrets[request.client_id as ServiceClient])
      : this.decoy;
    // Digests have one length, so the comparison always runs in full and the secret's length is not revealed.
    const matches = safeEqual(digest(request.client_secret), expected);
    if (!known || !matches) throw new DomainError('UNAUTHENTICATED', 'bad_credentials');

    const allowed = this.registry.serviceAudiences[request.client_id as ServiceClient];
    const audience = [...new Set(request.audience)];
    if (audience.length === 0 || !audience.every((target) => allowed.includes(target))) {
      throw new DomainError('FORBIDDEN_ROLE', 'audience');
    }
    return this.issue({ sub: request.client_id, azp: request.client_id, aud: audience });
  }

  private humanToken(request: Extract<TokenRequest, { grant_type: 'dev_login' }>): TokenResponse {
    const user = this.byUsername.get(request.username);
    const roles = hasOwn(this.registry.clientRoles, request.client_id)
      ? this.registry.clientRoles[request.client_id as HumanClient]
      : [];
    // The same answer for an unknown user and for a user who belongs to another client: nothing to enumerate.
    if (user === undefined || !roles.includes(user.role))
      throw new DomainError('UNAUTHENTICATED', 'bad_credentials');
    return this.issue({
      sub: user.id,
      azp: request.client_id,
      aud: [...this.registry.roleAudiences[user.role]],
      roles: [user.role],
      ...(request.client_id === CUSTOMER_CLIENT && user.customer_id !== undefined
        ? { customer_id: user.customer_id }
        : {}),
    });
  }

  private issue(claims: Record<string, unknown>): TokenResponse {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const token = signJwt(
      { iss: ISSUER, ...claims, iat, exp: iat + this.ttl, jti: randomUUID() },
      { privateKey: this.privateKey, kid: this.kid },
    );
    return { access_token: token, token_type: 'Bearer', expires_in: this.ttl };
  }
}
