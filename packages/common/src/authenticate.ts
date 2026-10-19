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

export interface AuthenticateOptions {
  readonly clock: Clock;
  readonly issuer: string;
  /** This service: both tokens must have been made for it (`aud`). */
  readonly service: string;
  readonly resolveKey: (kid: string | undefined) => KeyObject | undefined;
  /** Only the gateway sets this: customer tokens are accepted nowhere else (ADR-0007 item 4). */
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

// Tokens live at most five minutes (NFR-21); a longer one is refused even when its signature is good.
const MAX_LIFETIME_SECONDS = 300;
const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;
const CUSTOMER_ID = /^CUST-[0-9]{6}$/;

/** `azp` of a service account -> the name Privacy Service and the others use. */
const SERVICE_AZP: Readonly<Record<string, RequestingService>> = {
  'api-gateway': 'API_GATEWAY',
  transaction: 'TRANSACTION',
  fraud: 'FRAUD',
  notification: 'NOTIFICATION',
  reconciliation: 'RECONCILIATION',
};

const fail = (reason: 'UNAUTHENTICATED' | 'FORBIDDEN_ROLE', category: string): never => {
  // The category says which rule refused the call; it is the only thing that may travel with the error.
  throw new DomainError(reason, category);
};

/** One header value, exactly once: a repeated header could hide a second token from the check. */
function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return fail('UNAUTHENTICATED', 'repeated_header');
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
      return fail('FORBIDDEN_ROLE', 'audience');
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

/** Reads who the Authorization token says it is, and refuses a token whose claims do not fit that kind of caller. */
function principalOf(claims: Record<string, unknown>): Principal {
  const subject = claims['sub'];
  const azp = claims['azp'];
  if (typeof subject !== 'string' || subject === '' || typeof azp !== 'string') {
    return fail('UNAUTHENTICATED', 'claims');
  }
  const roles = rolesOf(claims);
  const hasCustomerId = claims['customer_id'] !== undefined;

  if (Object.hasOwn(SERVICE_AZP, azp)) {
    // A service account has no person's claims: roles or customer_id on it would be a forged mix.
    if (claims['roles'] !== undefined || hasCustomerId) return fail('UNAUTHENTICATED', 'claims');
    return { requestingService: SERVICE_AZP[azp] as RequestingService, subject };
  }
  if (azp === 'bank-simulator') {
    if (roles?.length !== 1 || roles[0] !== 'bank' || hasCustomerId)
      return fail('UNAUTHENTICATED', 'claims');
    return { requestingService: 'BANK', subject };
  }
  if (azp === 'admin-console') {
    const role = humanRole(claims);
    if (role === undefined || hasCustomerId) return fail('UNAUTHENTICATED', 'claims');
    return { requestingService: 'ADMIN_CONSOLE', subject, role };
  }
  if (azp === 'customer-app') {
    const customerId = claims['customer_id'];
    if (roles?.length !== 1 || roles[0] !== 'customer') return fail('UNAUTHENTICATED', 'claims');
    if (typeof customerId !== 'string' || !CUSTOMER_ID.test(customerId))
      return fail('UNAUTHENTICATED', 'claims');
    return { requestingService: 'CUSTOMER', subject, customerId };
  }
  return fail('UNAUTHENTICATED', 'azp');
}

/** The person in an X-Actor-Token: a person of the admin console with exactly one role, never anything else. */
function actorOf(
  token: string,
  options: AuthenticateOptions,
): { actorId: string; role: HumanRole } {
  const claims = verified(token, options);
  const role = humanRole(claims);
  const subject = claims['sub'];
  if (
    claims['azp'] !== 'admin-console' ||
    role === undefined ||
    claims['customer_id'] !== undefined
  ) {
    return fail('FORBIDDEN_ROLE', 'not_a_person');
  }
  if (typeof subject !== 'string' || subject === '') return fail('UNAUTHENTICATED', 'claims');
  return { actorId: subject, role };
}

/**
 * Who is calling and on whose behalf (ADR-0007, platform spec 7). The caller is the `azp` of the Authorization token,
 * mapped through a fixed allowlist: no body field, claim, or other header can change it (D-16). A person may be
 * carried in X-Actor-Token by a service account; a token that already is a person takes none, and neither do the bank
 * and customers. `aud` of both tokens must name this service, which is how an actor token is limited to the services
 * on its role's path (K-03). Throws UNAUTHENTICATED (no or invalid proof) or FORBIDDEN_ROLE (a genuine caller that may
 * not do this), each with a short category and never a token.
 */
export function authenticate(headers: AuthHeaders, options: AuthenticateOptions): Authenticated {
  const authorization = single(headers['authorization']);
  const token = authorization === undefined ? undefined : BEARER.exec(authorization)?.[1];
  if (token === undefined) return fail('UNAUTHENTICATED', 'no_bearer');

  const principal = principalOf(verified(token, options));
  if (principal.requestingService === 'CUSTOMER') {
    if (options.acceptCustomerToken !== true || options.service !== 'api-gateway') {
      return fail('FORBIDDEN_ROLE', 'customer_token');
    }
  }

  const actorToken = single(headers['x-actor-token']);
  if (actorToken !== undefined) {
    if (principal.requestingService === 'ADMIN_CONSOLE')
      return fail('FORBIDDEN_ROLE', 'double_identity');
    if (principal.requestingService === 'BANK' || principal.requestingService === 'CUSTOMER') {
      return fail('FORBIDDEN_ROLE', 'actor_not_allowed');
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
