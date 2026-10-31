'use strict';
// `pnpm docker:keycloak-check`: checks the RUNNING Keycloak of the Compose profile `keycloak` from inside the business
// network (DK-04, ADR-0017): the JWKS has one RS256 signing key (and the encryption key Kong and the services must not
// use), a service account and a customer get tokens whose claims have the shape the services expect, and a wrong secret is
// refused. It runs in a throwaway container of the keycloak-realm service (it has the secrets mounted). Nothing printed
// holds a token, a secret or a password; only claim names and checks.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = `
const fs = require('node:fs');
const base = 'http://keycloak:8080/realms/privpay/protocol/openid-connect';
const secret = (name) => fs.readFileSync('/run/secrets/' + name, 'utf8').trim();
const form = (body) => fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const results = [];
const check = (label, ok) => results.push([label, ok]);
(async () => {
  const jwks = await (await fetch(base + '/certs')).json();
  const sig = jwks.keys.filter((k) => k.use === 'sig' && k.alg === 'RS256');
  check('JWKS: exactly one RS256 signing key, and an encryption key that must be ignored', sig.length === 1 && jwks.keys.some((k) => k.use === 'enc'));
  const service = await form({ grant_type: 'client_credentials', client_id: 'api-gateway', client_secret: secret('api-gateway_client_secret') });
  const sc = claims((await service.json()).access_token);
  check('service account: azp api-gateway, audiences of its table, no roles, no customer_id, lifetime <= 300 s',
    sc.azp === 'api-gateway' && ['privacy-service', 'transaction-service', 'notification-service', 'reconciliation-service'].every((a) => sc.aud.includes(a)) && sc.roles === undefined && sc.customer_id === undefined && sc.exp - sc.iat <= 300);
  const wrong = await form({ grant_type: 'client_credentials', client_id: 'api-gateway', client_secret: 'not-the-secret-0123456789' });
  check('a wrong client secret is refused', wrong.status === 401);
  const customer = await form({ grant_type: 'password', client_id: 'customer-app', username: 'nasabah.uji.101', password: secret('keycloak_dev_user_password') });
  const cc = claims((await customer.json()).access_token);
  check('customer: one role, aud api-gateway, customer_id of the form CUST-nnnnnn', JSON.stringify(cc.roles) === '["customer"]' && cc.aud.includes('api-gateway') && /^CUST-[0-9]{6}$/.test(cc.customer_id));
  check('issuer is the fixed name of the realm, whatever address was used', sc.iss === 'http://keycloak:8080/realms/privpay');
  for (const [label, ok] of results) console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})().catch(() => { console.log('FAIL  Keycloak could not be reached'); process.exit(1); });
`;

const dir = path.join(__dirname, '..', '..', 'deploy', 'compose');
const result = spawnSync(
  'docker',
  ['compose', '-p', process.env['KEYCLOAK_COMPOSE_PROJECT'] ?? 'privpay-kc', '-f', path.join(dir, 'docker-compose.yml'), '-f', path.join(dir, 'mode.baseline.yml'),
    '--profile', 'keycloak', 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'keycloak-realm', '-e', script],
  { encoding: 'utf8', timeout: 120_000 },
);
process.stdout.write(result.stdout);
if (result.status !== 0 && !/PASS|FAIL/.test(result.stdout)) process.stderr.write('could not run the check (is the profile up?)\n');
process.exitCode = result.status ?? 1;
