// Who the dev IdP knows and what it may put in a token (ADR-0007). Keycloak takes this over in the Docker phase
// (DK-04); until then these tables are the single place that says which client may ask for which audience.

export const ISSUER = 'privpay-dev-idp';
/** The audience of tokens meant for the dev IdP's own admin API. */
export const DEV_IDP_AUDIENCE = 'dev-idp';

export const SERVICE_CLIENTS = [
  'api-gateway',
  'transaction',
  'fraud',
  'notification',
  'reconciliation',
] as const;
export type ServiceClient = (typeof SERVICE_CLIENTS)[number];

export const HUMAN_CLIENTS = ['customer-app', 'admin-console', 'bank-simulator'] as const;
export type HumanClient = (typeof HUMAN_CLIENTS)[number];

export const ROLES = ['customer', 'admin', 'auditor', 'fraud_analyst', 'bank'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The services each service account may ask a token for. Derived from the one-way call flow of invariant 3 (the
 * Gateway calls downwards; Privacy calls nobody) and ADR-0007; later tickets add a line here when a new call appears.
 * Only the Gateway may reach the IdP's admin API (AZ-38, AZ-39).
 */
export const SERVICE_AUDIENCES: Readonly<Record<ServiceClient, readonly string[]>> = {
  'api-gateway': [
    'privacy-service',
    'transaction-service',
    'notification-service',
    'reconciliation-service',
    DEV_IDP_AUDIENCE,
  ],
  transaction: ['privacy-service', 'fraud-service', 'notification-service'],
  fraud: ['privacy-service'],
  notification: ['privacy-service'],
  reconciliation: ['privacy-service', 'transaction-service'],
};

/** Which human client signs which roles in (a customer never gets an admin token, and the other way round). */
export const CLIENT_ROLES: Readonly<Record<HumanClient, readonly Role[]>> = {
  'customer-app': ['customer'],
  'admin-console': ['admin', 'auditor', 'fraud_analyst'],
  'bank-simulator': ['bank'],
};

/**
 * `aud` of a human token, by role. An actor token reaches only the services on its role's path, so a compromised
 * downstream service cannot replay it elsewhere (platform spec 7 item 6, K-03).
 */
export const ROLE_AUDIENCES: Readonly<Record<Role, readonly string[]>> = {
  customer: ['api-gateway'],
  bank: ['api-gateway'],
  admin: ['api-gateway', 'privacy-service'],
  auditor: ['api-gateway', 'reconciliation-service', 'privacy-service'],
  fraud_analyst: ['api-gateway', 'transaction-service'],
};

export interface Registry {
  readonly serviceAudiences: Readonly<Record<ServiceClient, readonly string[]>>;
  readonly clientRoles: Readonly<Record<HumanClient, readonly Role[]>>;
  readonly roleAudiences: Readonly<Record<Role, readonly string[]>>;
}

export const DEFAULT_REGISTRY: Registry = {
  serviceAudiences: SERVICE_AUDIENCES,
  clientRoles: CLIENT_ROLES,
  roleAudiences: ROLE_AUDIENCES,
};
