import type { KeyObject } from 'node:crypto';
import type { Clock } from './clock';
import { DomainError } from './errors';
import { verifyJwt, type JwtFailure } from './jwt';

/** Who is calling, as the platform names callers (ADR-0007 item 1). */
export type RequestingService =
  | 'API_GATEWAY'
  | 'TRANSACTION'
  | 'FRAUD'
  | 'NOTIFICATION'
  | 'RECONCILIATION'
  | 'ADMIN_CONSOLE'
  | 'BANK'
  | 'CUSTOMER';

export const HUMAN_ROLES = ['admin', 'auditor', 'fraud_analyst'] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];

/**
 * The services each role's operations pass through (platform spec 7 item 6, K-03). The issuer writes `aud` from this
 * table; the receiver checks it again, so a token with a too-wide `aud` still cannot be used off its path.
 */
export const ROLE_SERVICES: Readonly<Record<HumanRole, readonly string[]>> = {
  auditor: ['api-gateway', 'reconciliation-service', 'privacy-service'],
  fraud_analyst: ['api-gateway', 'transaction-service'],
  // Also reconciliation-service: the administrator starts the daily run (AZ-08), and Reconciliation checks the actor token.
  admin: ['api-gateway', 'privacy-service', 'reconciliation-service'],
};

/** The gateway is the only service that takes customer tokens (ADR-0007 item 4). */
const GATEWAY_SERVICE = 'api-gateway';

export interface AuthenticateOptions {
  readonly clock: Clock;
  readonly issuer: string;
  /** This service: both tokens must have been made for it (`aud`). */
  readonly service: string;
  readonly resolveKey: (kid: string | undefined) => KeyObject | undefined;
  /** Set by the gateway only; every other service refuses customer tokens whatever this says. */
  readonly acceptCustomerToken?: boolean;
}

/** The request headers as Node gives them (lower-case names). Nothing but the two below is ever read. */
export type AuthHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface Authenticated {
  readonly requestingService: RequestingService;
  /** `sub` of the Authorization token. */
  readonly subject: string;
  /** The person behind the call: from X-Actor-Token, or from the Authorization token when that is a person. */
  readonly actor?: { readonly actorId: string; readonly role: HumanRole };
  /** From the customer token's claim; set only for CUSTOMER. */
  readonly customerId?: string;
}

/** Which rule refused the call. It is the only thing that travels with the error: never a token, never a claim. */
export type AuthFailure =
  | JwtFailure
  | 'no_bearer'
  | 'repeated_header'
  | 'claims'
  | 'azp'
  | 'customer_token'
  | 'double_identity'
  | 'actor_not_allowed'
  | 'not_a_person'
  | 'role_not_here';

// Tokens live at most five minutes (NFR-21); a longer one is refused even when its signature is good.
const MAX_LIFETIME_SECONDS = 300;
// RFC 7235: the scheme name is case-insensitive; the token after it is not.
const BEARER = /^bearer ([A-Za-z0-9._-]+)$/i;
const CUSTOMER_ID = /^CUST-[0-9]{6}$/;

/** `azp` of a service account -> the name Privacy Service and the others use. */
const SERVICE_AZP: Readonly<Record<string, RequestingService>> = {
  'api-gateway': 'API_GATEWAY',
  transaction: 'TRANSACTION',
  fraud: 'FRAUD',
  notification: 'NOTIFICATION',
  reconciliation: 'RECONCILIATION',
};

const refuse = (reason: 'UNAUTHENTICATED' | 'FORBIDDEN_ROLE', category: AuthFailure): never => {
  throw new DomainError(reason, category);
};

/** The token in an `Authorization: Bearer <token>` value, or undefined when it is not that. */
export function parseBearer(value: string | undefined): string | undefined {
  return value === undefined ? undefined : BEARER.exec(value)?.[1];
}

/**
 * One header value, exactly once. Node already keeps only the first of a repeated `authorization` header and joins a
 * repeated `x-actor-token` with a comma (which then fails as a token); the array case is for other adapters, so a
 * repeated header can never hide a second token from the check.
 */
function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return refuse('UNAUTHENTICATED', 'repeated_header');
  return value;
}

function verified(token: string, options: AuthenticateOptions): Record<string, unknown> {
  try {
    return verifyJwt(token, {
      clock: options.clock,
      issuer: options.issuer,
      audience: options.service,
      resolveKey: options.resolveKey,
      maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
    });
  } catch (error) {
    // A genuine token made for another service is a caller that may not be here (403), not a forged one (401).
    if (error instanceof DomainError && error.cause === ('audience' satisfies JwtFailure)) {
      return refuse('FORBIDDEN_ROLE', 'audience');
    }
    throw error;
  }
}

const rolesOf = (claims: Record<string, unknown>): unknown[] | undefined =>
  Array.isArray(claims['roles']) ? (claims['roles'] as unknown[]) : undefined;

function humanRole(claims: Record<string, unknown>): HumanRole | undefined {
  const roles = rolesOf(claims);
  const role = roles?.length === 1 ? roles[0] : undefined;
  return HUMAN_ROLES.find((allowed) => allowed === role);
}

interface Principal {
  readonly requestingService: RequestingService;
  readonly subject: string;
  readonly role?: HumanRole;
  readonly customerId?: string;
}

const MAX_SUBJECT_LENGTH = 64;

/**
 * Who a verified token says it is, by its `azp`, and a refusal for a token whose claims do not fit that kind of
 * caller. Used for the Authorization token and for the actor token alike, so both are held to the same rules.
 */
function principalOf(claims: Record<string, unknown>): Principal {
  const subject = claims['sub'];
  const azp = claims['azp'];
  if (typeof subject !== 'string' || subject === '' || typeof azp !== 'string') {
    return refuse('UNAUTHENTICATED', 'claims');
  }
  // The columns that record a person (reviewed_by, actor_id, requester_id, approver_id) hold 64 characters: a longer id
  // is refused here as a bad request, instead of becoming a database error halfway through the operation.
  if (subject.length > MAX_SUBJECT_LENGTH)
    throw new DomainError('VALIDATION_ERROR', 'subject_length');
  const roles = rolesOf(claims);
  const hasCustomerId = claims['customer_id'] !== undefined;

  if (Object.hasOwn(SERVICE_AZP, azp)) {
    // A service account has no person's claims: roles or customer_id on it would be a forged mix.
    if (claims['roles'] !== undefined || hasCustomerId) return refuse('UNAUTHENTICATED', 'claims');
    // ADR-0017, T-15: a service token is made for one service. A wider one could be replayed by a receiver that was taken
    // over at every other service the account may call, until `exp`, so it is refused even where it names this service.
    const audience = claims['aud'];
    if (Array.isArray(audience) && audience.length !== 1)
      return refuse('FORBIDDEN_ROLE', 'audience');
    return { requestingService: SERVICE_AZP[azp] as RequestingService, subject };
  }
  if (azp === 'bank-simulator') {
    if (roles?.length !== 1 || roles[0] !== 'bank' || hasCustomerId) {
      return refuse('UNAUTHENTICATED', 'claims');
    }
    return { requestingService: 'BANK', subject };
  }
  if (azp === 'admin-console') {
    const role = humanRole(claims);
    if (role === undefined || hasCustomerId) return refuse('UNAUTHENTICATED', 'claims');
    return { requestingService: 'ADMIN_CONSOLE', subject, role };
  }
  if (azp === 'customer-app') {
    const customerId = claims['customer_id'];
    if (roles?.length !== 1 || roles[0] !== 'customer') return refuse('UNAUTHENTICATED', 'claims');
    if (typeof customerId !== 'string' || !CUSTOMER_ID.test(customerId)) {
      return refuse('UNAUTHENTICATED', 'claims');
    }
    return { requestingService: 'CUSTOMER', subject, customerId };
  }
  return refuse('UNAUTHENTICATED', 'azp');
}

/** A person may only act where their role's operations pass (K-03), whatever `aud` the issuer wrote. */
function assertRoleHere(role: HumanRole, options: AuthenticateOptions): void {
  if (!ROLE_SERVICES[role].includes(options.service)) refuse('FORBIDDEN_ROLE', 'role_not_here');
}

/** The person in an X-Actor-Token: a person of the admin console with exactly one role, never anything else. */
function actorOf(
  token: string,
  options: AuthenticateOptions,
): { actorId: string; role: HumanRole } {
  const principal = principalOf(verified(token, options));
  if (principal.requestingService !== 'ADMIN_CONSOLE' || principal.role === undefined) {
    return refuse('FORBIDDEN_ROLE', 'not_a_person');
  }
  assertRoleHere(principal.role, options);
  return { actorId: principal.subject, role: principal.role };
}

/**
 * Who is calling and on whose behalf (ADR-0007, platform spec 7). The caller is the `azp` of the Authorization token,
 * mapped through a fixed allowlist: no body field, claim, or other header can change it (D-16). A person may be
 * carried in X-Actor-Token by a service account; a token that already is a person takes none, and neither do the bank
 * and customers. `aud` of both tokens must name this service, and a person's role must pass through it (K-03).
 * Throws UNAUTHENTICATED (no or invalid proof) or FORBIDDEN_ROLE (a genuine caller that may not do this), each with a
 * short category as `cause`, never a token.
 */
export function authenticate(headers: AuthHeaders, options: AuthenticateOptions): Authenticated {
  const token = parseBearer(single(headers['authorization']));
  if (token === undefined) return refuse('UNAUTHENTICATED', 'no_bearer');

  const principal = principalOf(verified(token, options));
  if (principal.requestingService === 'CUSTOMER') {
    if (options.acceptCustomerToken !== true || options.service !== GATEWAY_SERVICE) {
      return refuse('FORBIDDEN_ROLE', 'customer_token');
    }
  }
  if (principal.role !== undefined) assertRoleHere(principal.role, options);

  const actorToken = single(headers['x-actor-token']);
  if (actorToken !== undefined) {
    if (principal.requestingService === 'ADMIN_CONSOLE') {
      return refuse('FORBIDDEN_ROLE', 'double_identity');
    }
    if (principal.requestingService === 'BANK' || principal.requestingService === 'CUSTOMER') {
      return refuse('FORBIDDEN_ROLE', 'actor_not_allowed');
    }
    return {
      requestingService: principal.requestingService,
      subject: principal.subject,
      actor: actorOf(actorToken, options),
    };
  }

  return {
    requestingService: principal.requestingService,
    subject: principal.subject,
    ...(principal.role === undefined
      ? {}
      : { actor: { actorId: principal.subject, role: principal.role } }),
    ...(principal.customerId === undefined ? {} : { customerId: principal.customerId }),
  };
}
