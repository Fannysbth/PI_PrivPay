'use strict';
// The Keycloak realm of the Docker phase (DK-04, ADR-0007, ADR-0017): built at start from the tables of the system and from
// secret FILES, never from literals, and written to a volume that only Keycloak reads. The repository holds no client
// secret and no password. Plain Node, no dependency, so the same file runs in Compose (inside the gateway image) and in tests.
//
//   node scripts/docker/keycloak-realm.cjs <secrets-dir> <out-file>
//
// Claim contract kept from the dev IdP (packages/common/src/authenticate.ts):
//   sub, azp (client id), aud (by role or by service account), exp <= 300 s,
//   roles (exactly one, human tokens only), customer_id (customers only), and nothing of `roles` on a service account.
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const REALM = 'privpay';
const ISSUER_BASE = 'http://keycloak:8080';

// Who may reach what (the tables of tools/dev-idp/src/registry.ts and ROLE_SERVICES of @privpay/common).
const RESOURCES = ['api-gateway', 'privacy-service', 'transaction-service', 'fraud-service', 'notification-service', 'reconciliation-service', 'sms-simulator'];
const SERVICE_CLIENTS = {
  'api-gateway': ['privacy-service', 'transaction-service', 'notification-service', 'reconciliation-service'],
  transaction: ['privacy-service', 'fraud-service', 'notification-service'],
  fraud: [],
  notification: ['privacy-service', 'sms-simulator'],
  reconciliation: ['privacy-service', 'transaction-service'],
};
const ROLE_AUDIENCES = {
  customer: ['api-gateway'],
  bank: ['api-gateway'],
  admin: ['api-gateway', 'privacy-service', 'reconciliation-service'],
  auditor: ['api-gateway', 'reconciliation-service', 'privacy-service'],
  fraud_analyst: ['api-gateway', 'transaction-service'],
};
const CLIENT_ROLES = {
  'customer-app': ['customer'],
  'admin-console': ['admin', 'auditor', 'fraud_analyst'],
  'bank-simulator': ['bank'],
};
// Fictional test users (tools/dev-idp/users.dev.json). Two admins and two auditors: four eyes needs two persons.
const USERS = [
  ['nasabah.uji.101', 'customer', 'CUST-000101'],
  ['nasabah.uji.102', 'customer', 'CUST-000102'],
  ['nasabah.uji.103', 'customer', 'CUST-000103'],
  ['admin.uji.1', 'admin'],
  ['admin.uji.2', 'admin'],
  ['auditor.uji.1', 'auditor'],
  ['auditor.uji.2', 'auditor'],
  ['analis.uji.1', 'fraud_analyst'],
  ['bank.uji.1', 'bank'],
];

// DK-04c, ADR-0017: the audience of a service token is not written from the roles of the account but asked for, one service at
// a time, by an optional client scope `aud-<service>` (mapper `oidc-audience-mapper`). A client may ask only for the scopes
// of its own row in SERVICE_CLIENTS (anything else is `invalid_scope`), and the token then names that one service.
const audienceScope = (service) => `aud-${service}`;
const audienceScopes = () =>
  [...new Set(Object.values(SERVICE_CLIENTS).flat())].sort().map((service) => ({
    name: audienceScope(service),
    protocol: 'openid-connect',
    attributes: { 'include.in.token.scope': 'false', 'display.on.consent.screen': 'false' },
    protocolMappers: [
      {
        name: 'audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.client.audience': service, 'access.token.claim': 'true', 'id.token.claim': 'false', 'introspection.token.claim': 'true' },
      },
    ],
  }));
// Declaring the client scopes of the realm replaces the built-in ones, so `basic` (the `sub` claim) is declared here too.
const basicScope = {
  name: 'basic',
  protocol: 'openid-connect',
  attributes: { 'include.in.token.scope': 'false', 'display.on.consent.screen': 'false' },
  protocolMappers: [
    { name: 'sub', protocol: 'openid-connect', protocolMapper: 'oidc-sub-mapper', config: { 'access.token.claim': 'true', 'introspection.token.claim': 'true' } },
  ],
};

// DK-04c, ADR-0017 item 5: one password per class of user, so that a component holding one cannot sign in as another class.
// The file of each class under the secrets directory; the gateway reads only the customer one and the bank simulator only the
// bank one. `admin-console` is a confidential client: the password grant of an administrator, auditor, or analyst also needs
// its client secret, which neither of them holds.
const PASSWORD_FILES = {
  customer: 'keycloak_password_customer',
  admin: 'keycloak_password_admin',
  auditor: 'keycloak_password_auditor',
  fraud_analyst: 'keycloak_password_analyst',
  bank: 'keycloak_password_bank',
};
const CONFIDENTIAL_HUMAN_CLIENTS = ['admin-console'];

// Two ways to get an audience, on purpose: a person's token names the services of the role (audience-resolve over the roles,
// K-03: the receiver checks the role against its own path), a service token names the ONE service asked for (scope above).
const audienceResolve = {
  name: 'audience-from-roles',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-resolve-mapper',
  config: { 'access.token.claim': 'true', 'introspection.token.claim': 'true' },
};
const rolesClaim = {
  name: 'roles',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usermodel-realm-role-mapper',
  config: { multivalued: 'true', 'claim.name': 'roles', 'jsonType.label': 'String', 'access.token.claim': 'true', 'id.token.claim': 'false', 'userinfo.token.claim': 'false', 'introspection.token.claim': 'true' },
};
const customerIdClaim = {
  name: 'customer_id',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usermodel-attribute-mapper',
  config: { 'user.attribute': 'customer_id', 'claim.name': 'customer_id', 'jsonType.label': 'String', 'access.token.claim': 'true', 'id.token.claim': 'false', 'userinfo.token.claim': 'false', 'introspection.token.claim': 'true' },
};

/**
 * `clientSecrets`: { <client>: secret } for the service accounts, the admin client, and `admin-console`.
 * `passwords`: { <class>: password }, the five classes of PASSWORD_FILES, all different.
 * Returns the realm representation (Keycloak import format).
 */
function renderRealm({ clientSecrets, passwords, adminClient = 'idp-admin' }) {
  for (const name of [...Object.keys(SERVICE_CLIENTS), adminClient, ...CONFIDENTIAL_HUMAN_CLIENTS]) {
    if (typeof clientSecrets[name] !== 'string' || clientSecrets[name].length < 16) throw new Error(`secret of client ${name} is missing or too short`);
  }
  for (const klass of Object.keys(PASSWORD_FILES)) {
    if (typeof passwords?.[klass] !== 'string' || passwords[klass].length < 16) throw new Error(`the password of class ${klass} is missing or too short`);
  }
  if (new Set(Object.keys(PASSWORD_FILES).map((klass) => passwords[klass])).size !== Object.keys(PASSWORD_FILES).length) {
    throw new Error('the passwords of the classes must be distinct');
  }

  const clients = [];
  // Bearer-only resources: they exist only so that an audience can be named after them (aud of the token).
  for (const name of RESOURCES) clients.push({ clientId: name, enabled: true, bearerOnly: true, publicClient: false, protocol: 'openid-connect' });
  // Service accounts: client credentials, no `roles`, no `customer_id`, and no audience unless one is asked for by scope.
  for (const name of Object.keys(SERVICE_CLIENTS)) {
    const existing = clients.find((client) => client.clientId === name);
    const entry = {
      clientId: name, enabled: true, publicClient: false, secret: clientSecrets[name], protocol: 'openid-connect',
      serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false, implicitFlowEnabled: false,
      fullScopeAllowed: true, defaultClientScopes: ['basic'], optionalClientScopes: SERVICE_CLIENTS[name].map(audienceScope),
    };
    if (existing) Object.assign(existing, entry, { bearerOnly: false });
    else clients.push(entry);
  }
  // The only client allowed to manage users (registration, compensation). Its token never goes to a service.
  clients.push({
    clientId: adminClient, enabled: true, publicClient: false, secret: clientSecrets[adminClient], protocol: 'openid-connect',
    serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false, fullScopeAllowed: true,
    defaultClientScopes: ['basic'], optionalClientScopes: [],
  });
  // Humans: password grant (dev only). A client signs only the roles of its own kind in (a customer never gets an admin token).
  for (const [client, roles] of Object.entries(CLIENT_ROLES)) {
    clients.push({
      clientId: client, enabled: true, protocol: 'openid-connect', directAccessGrantsEnabled: true,
      // The client of the privileged classes needs its secret for the password grant; the others stay public (dev only).
      ...(CONFIDENTIAL_HUMAN_CLIENTS.includes(client) ? { publicClient: false, secret: clientSecrets[client] } : { publicClient: true }),
      standardFlowEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false, fullScopeAllowed: false,
      defaultClientScopes: ['basic'], optionalClientScopes: [],
      protocolMappers: [audienceResolve, rolesClaim, ...(roles.includes('customer') ? [customerIdClaim] : [])],
    });
  }

  const realmRoles = Object.entries(ROLE_AUDIENCES).map(([name, audiences]) => ({
    name, composite: true, composites: { client: Object.fromEntries(audiences.map((audience) => [audience, ['access']])) },
  }));
  const clientRoles = Object.fromEntries(RESOURCES.map((name) => [name, [{ name: 'access' }]]));

  const users = [];
  for (const name of Object.keys(SERVICE_CLIENTS)) {
    users.push({ username: `service-account-${name}`, enabled: true, serviceAccountClientId: name });
  }
  users.push({
    username: `service-account-${adminClient}`, enabled: true, serviceAccountClientId: adminClient,
    clientRoles: { 'realm-management': ['manage-users', 'query-users', 'view-users', 'view-realm'] },
  });
  for (const [username, role, customerId] of USERS) {
    users.push({
      username, enabled: true, emailVerified: true,
      credentials: [{ type: 'password', value: passwords[role], temporary: false }],
      realmRoles: [role],
      ...(customerId ? { attributes: { customer_id: [customerId] } } : {}),
    });
  }

  // A user profile with `customer_id` as a managed attribute and no mandatory name or e-mail (the system keeps none, N-08).
  const profile = {
    attributes: [
      { name: 'username', displayName: '${username}', validations: { length: { min: 3, max: 64 } }, permissions: { view: ['admin', 'user'], edit: ['admin'] } },
      // Keycloak refuses a profile without `email`; it is optional here and no user of the system has one (N-08).
      { name: 'email', displayName: 'email', validations: { length: { max: 255 } }, permissions: { view: ['admin'], edit: ['admin'] } },
      { name: 'customer_id', displayName: 'customer_id', validations: { pattern: { pattern: '^CUST-[0-9]{6}$', 'error-message': 'customer_id' } }, permissions: { view: ['admin'], edit: ['admin'] } },
    ],
  };

  return {
    realm: REALM, enabled: true, sslRequired: 'none', registrationAllowed: false, resetPasswordAllowed: false,
    accessTokenLifespan: 300, ssoSessionIdleTimeout: 1800, accessTokenLifespanForImplicitFlow: 300,
    defaultRole: { name: `default-roles-${REALM}`, description: 'none', composite: false, clientRole: false },
    roles: { realm: realmRoles, client: clientRoles },
    scopeMappings: Object.entries(CLIENT_ROLES).map(([client, roles]) => ({ client, roles })),
    clients, users,
    clientScopes: [basicScope, ...audienceScopes()],
    components: {
      'org.keycloak.userprofile.UserProfileProvider': [
        { providerId: 'declarative-user-profile', subComponents: {}, config: { 'kc.user.profile.config': [JSON.stringify(profile)] } },
      ],
    },
  };
}

const readSecret = (dir, name) => readFileSync(path.join(dir, name), 'utf8').trim();

/** The password class of a fictional test user, from USERS (the one table). An unknown name is an error, never a default. */
const classOfUser = (username) => {
  const row = USERS.find(([name]) => name === username);
  if (row === undefined) throw new Error(`no password class for user ${username}`);
  return row[1];
};

module.exports = { renderRealm, audienceScope, classOfUser, PASSWORD_FILES, CONFIDENTIAL_HUMAN_CLIENTS, REALM, ISSUER_BASE, USERS, SERVICE_CLIENTS, CLIENT_ROLES, ROLE_AUDIENCES, RESOURCES };

if (require.main === module) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    process.stderr.write('usage: keycloak-realm.cjs <secrets-dir> <out-file>\n');
    process.exit(2);
  }
  const clientSecrets = {};
  for (const name of Object.keys(SERVICE_CLIENTS)) clientSecrets[name] = readSecret(dir, `${name}_client_secret`);
  clientSecrets['idp-admin'] = readSecret(dir, 'idp-admin_client_secret');
  for (const name of CONFIDENTIAL_HUMAN_CLIENTS) clientSecrets[name] = readSecret(dir, `${name}_client_secret`);
  const passwords = Object.fromEntries(Object.entries(PASSWORD_FILES).map(([klass, file]) => [klass, readSecret(dir, file)]));
  const realm = renderRealm({ clientSecrets, passwords });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(realm), { mode: 0o644 });
  process.stdout.write('keycloak realm written\n');
}
