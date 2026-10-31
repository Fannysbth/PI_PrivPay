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

/** `secrets`: { clients: { <client>: secret }, password: string }. Returns the realm representation (Keycloak import format). */
function renderRealm({ clientSecrets, devPassword, adminClient = 'idp-admin' }) {
  for (const name of [...Object.keys(SERVICE_CLIENTS), adminClient]) {
    if (typeof clientSecrets[name] !== 'string' || clientSecrets[name].length < 16) throw new Error(`secret of client ${name} is missing or too short`);
  }
  if (typeof devPassword !== 'string' || devPassword.length < 16) throw new Error('the dev password is missing or too short');

  const clients = [];
  // Bearer-only resources: they exist only so that an audience can be named after them (aud of the token).
  for (const name of RESOURCES) clients.push({ clientId: name, enabled: true, bearerOnly: true, publicClient: false, protocol: 'openid-connect' });
  // Service accounts: client credentials, an audience per allowed service, no `roles`, no `customer_id`.
  for (const name of Object.keys(SERVICE_CLIENTS)) {
    const existing = clients.find((client) => client.clientId === name);
    const entry = {
      clientId: name, enabled: true, publicClient: false, secret: clientSecrets[name], protocol: 'openid-connect',
      serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false, implicitFlowEnabled: false,
      fullScopeAllowed: true, defaultClientScopes: ['basic'], optionalClientScopes: [], protocolMappers: [audienceResolve],
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
      clientId: client, enabled: true, publicClient: true, protocol: 'openid-connect', directAccessGrantsEnabled: true,
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
  for (const [name, targets] of Object.entries(SERVICE_CLIENTS)) {
    users.push({
      username: `service-account-${name}`, enabled: true, serviceAccountClientId: name,
      clientRoles: Object.fromEntries(targets.map((target) => [target, ['access']])),
    });
  }
  users.push({
    username: `service-account-${adminClient}`, enabled: true, serviceAccountClientId: adminClient,
    clientRoles: { 'realm-management': ['manage-users', 'query-users', 'view-users', 'view-realm'] },
  });
  for (const [username, role, customerId] of USERS) {
    users.push({
      username, enabled: true, emailVerified: true,
      credentials: [{ type: 'password', value: devPassword, temporary: false }],
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
    components: {
      'org.keycloak.userprofile.UserProfileProvider': [
        { providerId: 'declarative-user-profile', subComponents: {}, config: { 'kc.user.profile.config': [JSON.stringify(profile)] } },
      ],
    },
  };
}

const readSecret = (dir, name) => readFileSync(path.join(dir, name), 'utf8').trim();

module.exports = { renderRealm, REALM, ISSUER_BASE, USERS, SERVICE_CLIENTS, CLIENT_ROLES, ROLE_AUDIENCES, RESOURCES };

if (require.main === module) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    process.stderr.write('usage: keycloak-realm.cjs <secrets-dir> <out-file>\n');
    process.exit(2);
  }
  const clientSecrets = {};
  for (const name of Object.keys(SERVICE_CLIENTS)) clientSecrets[name] = readSecret(dir, `${name}_client_secret`);
  clientSecrets['idp-admin'] = readSecret(dir, 'idp-admin_client_secret');
  const realm = renderRealm({ clientSecrets, devPassword: readSecret(dir, 'keycloak_dev_user_password') });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(realm), { mode: 0o644 });
  process.stdout.write('keycloak realm written\n');
}
