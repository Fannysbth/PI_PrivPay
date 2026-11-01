'use strict';
// `pnpm docker:edge-check <proposed|baseline> [base|expiry|limits|claims]`: attacks the RUNNING edge (Kong, DK-02a) from the host over
// TLS and expects Kong to refuse in the one ADR-0008 shape. It needs the stack started with docs/postman/compose.postman.yml
// (Keycloak, the IdP of the stack since DK-04, published on 127.0.0.1:8080, only to mint tokens by password grant with the
// invented test password of secrets/docker; it is read here and never printed). Nothing here prints a token, a key or a certificate;
// the CA file is only the public certificate of the development CA.
//
//   base    TLS, token and size mutations, N-05 and header checks.        (stack as started by the Postman override)
//   expiry  an expired token: a real token of Keycloak (300 s) is used after it ended, so this phase waits 305 s.
//   claims  tokens that Kong accepts but the adapter must not: wrong audience, wrong client (azp), wrong role, a key that is
//           not the IdP's, and a user with two roles (made through the Admin API, removed again).
//   limits  the request rate. Start the stack with KONG_RATE_LIMIT_PER_MINUTE=20 first, so the check needs 21 requests.
// Exit code 0 only if every check came out as expected.
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { MODES, composeArgs, caFile, secretsDir } = require('./compose.cjs');

const HOST = '127.0.0.1';
const PORTS = { proposed: 4010, baseline: 4011 };
const IDP = { host: HOST, port: Number(process.env['IDP_HOST_PORT'] ?? 8080) };
const REALM_PATH = '/realms/privpay/protocol/openid-connect/token';
const readSecretFile = (name) => fs.readFileSync(path.join(secretsDir(), name), 'utf8').trim();
// DK-04c: one invented password per class of user (the files of PASSWORD_FILES), read once per run; the privileged human client
// also needs its secret. The class of a test user follows from its name.
const { PASSWORD_FILES, CONFIDENTIAL_HUMAN_CLIENTS, classOfUser } = require('./keycloak-realm.cjs');
const secretCache = new Map();
const readOnce = (file) => {
  if (!secretCache.has(file)) secretCache.set(file, readSecretFile(file));
  return secretCache.get(file);
};
const classPassword = (klass) => readOnce(PASSWORD_FILES[klass]);
// The secret of the privileged human client, read once like the passwords.
const consoleSecret = () => readOnce('admin-console_client_secret');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One HTTPS request to the edge. Resolves to { status, headers, body } or { error: code }. */
// Random per run: the log of the adapter outlives a run, so a repeated id would make "the adapter saw it" true from an older run.
const nextId = () => crypto.randomUUID();
const AT_EDGE = [];
/** Marks an answer as one the edge must give alone: the adapter must never log its request id. */
const edgeOnly = (answer) => {
  AT_EDGE.push(answer.id);
  return answer;
};

function call(port, { method = 'GET', url = '/', headers = {}, body, tls = {} }) {
  const id = headers['x-request-id'] ?? nextId();
  headers = { ...headers, 'x-request-id': id };
  return new Promise((resolve0) => {
    const resolve = (answer) => resolve0({ ...answer, id });
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const request = https.request(
      { host: HOST, port, method, path: url, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers }, timeout: 8000, ...tls },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ error: error.code ?? error.message }));
    request.end(payload);
  });
}

/** A request to the IdP; resolves to { status, json }. The body is never printed. */
function idpCall(method, urlPath, { form, json, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = form ? Buffer.from(new URLSearchParams(form).toString()) : json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    const headers = {
      ...(payload ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': payload.length } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const request = http.request({ ...IDP, method, path: urlPath, headers, timeout: 8000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = text === '' ? undefined : JSON.parse(text); } catch { parsed = undefined; }
        resolve({ status: response.statusCode, json: parsed });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new Error('Keycloak is not reachable on 127.0.0.1 (start the stack with docs/postman/compose.postman.yml)')));
    request.end(payload);
  });
}

// `klass` is only given for a user the check made itself (not in USERS).
async function mintToken(username = 'analis.uji.1', clientId = 'admin-console', klass = classOfUser(username)) {
  const form = { grant_type: 'password', client_id: clientId, username, password: classPassword(klass) };
  if (CONFIDENTIAL_HUMAN_CLIENTS.includes(clientId)) form.client_secret = consoleSecret();
  const answer = await idpCall('POST', REALM_PATH, { form });
  if (typeof answer.json?.access_token !== 'string') throw new Error('Keycloak gave no token');
  return answer.json.access_token;
}

/** The audience and the client of a token, for a label: names of services only, never the token. */
const claimSummary = (token) => {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return `aud=${JSON.stringify(claims.aud)} azp=${String(claims.azp)} roles=${JSON.stringify(claims.roles ?? null)}`;
};

// `audience` is the one service the token is for (scope aud-<service>, DK-04c); without it the token names none.
async function serviceToken(client, audience) {
  const form = { grant_type: 'client_credentials', client_id: client, client_secret: readSecretFile(`${client}_client_secret`) };
  if (audience !== undefined) form.scope = `aud-${audience}`;
  const answer = await idpCall('POST', REALM_PATH, { form });
  if (typeof answer.json?.access_token !== 'string') throw new Error('Keycloak gave no service token');
  return answer.json.access_token;
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const shape = (answer) => { try { const e = JSON.parse(answer.body).error; return e && Object.keys(e).sort().join() === 'code,message,request_id' && UUID.test(e.request_id) ? e.code : 'bad-shape'; } catch { return 'not-json'; } };
const refused = (answer) => (answer.error ? `error ${answer.error}` : `${answer.status} ${shape(answer)}`);
const tamper = (token) => { const [h, p, s] = token.split('.'); return `${h}.${p.slice(0, -2)}${p.endsWith('AA') ? 'BB' : 'AA'}.${s}`; };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const padding = (bytes) => ({ filler: 'a'.repeat(bytes) });

/** True if the adapter's own log (request ids only, no payload) mentions the id: whether the request got that far. */
function adapterLog(mode) {
  const result = spawnSync('docker', composeArgs(mode, ['logs', '--no-log-prefix', 'gateway']), { encoding: 'utf8', timeout: 30000 });
  return `${result.stdout}${result.stderr}`;
}
const BIG_ID = crypto.randomUUID();
const MID_ID = crypto.randomUUID();

async function baseChecks(mode, port, ca) {
  const token = await mintToken();
  const verified = { ca };
  const results = [];
  const add = (label, got, expected) => results.push([label, got, expected]);

  const health = await call(port, { url: '/health', tls: verified });
  add('TLS with the dev CA: /health answers with status only, and does not name the mode (N-54b)', health.error ?? `${health.status} ${health.body.includes('mode') || health.body.includes(mode) ? 'names-mode' : 'status-only'}`, '200 status-only');
  add('no server, via or x-kong headers on an answer (versions are not told)', Object.keys(health.headers ?? {}).filter((h) => /^(server|via|x-kong)/.test(h)).join(',') || 'none', 'none');
  add('a client without the dev CA rejects the certificate', (await call(port, {})).error, /^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)$/);
  add('a certificate for another name is rejected (connect with a wrong server name)', (await call(port, { tls: { ca, servername: 'wrong.example.test' } })).error, 'ERR_TLS_CERT_ALTNAME_INVALID');
  const plain = await new Promise((resolve) => {
    const request = http.get({ host: HOST, port, path: '/health', timeout: 3000 }, (response) => { response.resume(); resolve(`status ${response.statusCode}`); });
    request.on('error', (error) => resolve(`error ${error.code}`));
    request.on('timeout', () => { request.destroy(); resolve('error timeout'); });
  });
  add('plain HTTP to the edge port gets no 2xx', /^status 2/.test(plain) ? plain : 'refused', 'refused');

  const open = (extra = {}) => ({ url: '/transaction/held', tls: verified, ...extra });
  const control = await call(port, open({ headers: bearer(token) }));
  add('control: a valid token reaches the adapter through Kong', control.error ?? control.status, 200);
  add('no token', refused(edgeOnly(await call(port, open()))), '401 UNAUTHENTICATED');
  add('garbage token', refused(edgeOnly(await call(port, open({ headers: bearer('abc.def.ghi') })))), '401 UNAUTHENTICATED');
  add('token with a changed payload (signature no longer fits)', refused(edgeOnly(await call(port, open({ headers: bearer(tamper(token)) })))), '401 UNAUTHENTICATED');
  add('alg=none token', refused(edgeOnly(await call(port, open({ headers: bearer(`${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: 'http://keycloak:8080/realms/privpay', exp: 4102444800 })}.`) })))), '401 UNAUTHENTICATED');
  add('a valid token in the URL (?jwt=) is not read', refused(edgeOnly(await call(port, { url: `/transaction/held?jwt=${token}`, tls: verified }))), '401 UNAUTHENTICATED');

  const big = await call(port, { method: 'POST', url: '/transaction/TX-1/review', headers: { ...bearer(token), 'x-request-id': BIG_ID }, body: padding(100 * 1024), tls: verified });
  add('body of 100 KiB (over Kong\'s 64 KiB): 422 VALIDATION_ERROR, never Kong\'s own 413', refused(big), '422 VALIDATION_ERROR');
  const mid = await call(port, { method: 'POST', url: '/transaction/TX-1/review', headers: { ...bearer(token), 'x-request-id': MID_ID }, body: padding(20 * 1024), tls: verified });
  add('body of 20 KiB (over the route\'s 16 KiB, under Kong\'s): same answer, from the adapter', refused(mid), '422 VALIDATION_ERROR');


  const metrics = await call(port, { url: '/metrics', headers: bearer(token), tls: verified });
  add('/metrics is not offered on the edge, not even to a valid token (N-05)', `${refused(metrics)} ${/# (HELP|TYPE)/.test(metrics.body ?? '') ? 'LEAK' : 'no-metrics'}`, '422 VALIDATION_ERROR no-metrics');
  for (const variant of ['/metrics/', '/Metrics', '/METRICS/']) {
    const answer = await call(port, { url: variant, headers: bearer(token), tls: verified });
    add(`${variant} is refused as well (the adapter's router ignores case and a trailing slash)`, `${refused(answer)} ${/# (HELP|TYPE)/.test(answer.body ?? '') ? 'LEAK' : 'no-metrics'}`, '422 VALIDATION_ERROR no-metrics');
  }
  const open2 = await call(port, { method: 'POST', url: '/register', body: {}, tls: verified });
  add('/register is open without a token (the adapter answers, not Kong)', refused(open2), '422 VALIDATION_ERROR');
  add('another method on /health is not open (token asked first)', refused(await call(port, { method: 'POST', url: '/health', tls: verified })), '401 UNAUTHENTICATED');
  add('a path under /health is not open either', refused(await call(port, { url: '/health/x', tls: verified })), '401 UNAUTHENTICATED');
  // One read of the adapter log after the last request answers every "did it get that far" question.
  const log = adapterLog(mode);
  add('the 100 KiB request never reached the adapter, the 20 KiB one did', `${log.includes(BIG_ID) ? 'adapter-saw-big' : 'big-stopped'} ${log.includes(MID_ID) ? 'mid-reached' : 'mid-missing'}`, 'big-stopped mid-reached');
  add('none of the refused token requests reached the adapter (its log has none of their ids)', AT_EDGE.filter((id) => log.includes(id)).length, 0);
  return results;
}

async function expiryChecks(mode, port, ca) {
  const short = await mintToken();
  // The lifetime of a Keycloak token is the realm's 300 s; the check waits for it to end, with 5 s over. EXPIRY_WAIT_MS is
  // only for a stack whose realm was changed.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env['EXPIRY_WAIT_MS'] ?? 305000)));
  const answer = await call(port, { url: '/transaction/held', headers: bearer(short), tls: { ca } });
  return [
    ['expired token (a real token of Keycloak, used after its 300 s)', refused(answer), '401 UNAUTHENTICATED'],
    ['the expired token was stopped by Kong: the adapter never saw its request', adapterLog(mode).includes(answer.id), false],
  ];
}

/** The claims Kong cannot judge (audience, client, role, number of roles) and a signature by a key that is not the IdP's. */
async function claimChecks(mode, port, ca) {
  const verified = { ca };
  const results = [];
  const add = (label, got, expected) => results.push([label, got, expected]);
  const held = (token) => call(port, { url: '/transaction/held', headers: bearer(token), tls: verified });

  const analyst = await mintToken();
  add('control: an analyst of the console is let in', (await held(analyst)).status, 200);
  const reconciliation = await serviceToken('reconciliation', 'transaction-service');
  add(`a service account whose audience does not include api-gateway (reconciliation: ${claimSummary(reconciliation)})`, refused(await held(reconciliation)), '403 ACCESS_DENIED');
  add('a customer asking for a token at the admin client (azp admin-console) gets no usable role', refused(await held(await mintToken('nasabah.uji.103', 'admin-console'))), '401 UNAUTHENTICATED');
  add('an administrator asking for a token at the customer client (azp customer-app) gets no usable role', refused(await held(await mintToken('admin.uji.1', 'customer-app'))), '401 UNAUTHENTICATED');
  add('a customer on a route of the console (wrong role)', refused(await held(await mintToken('nasabah.uji.102', 'customer-app'))), '403 ACCESS_DENIED');

  // Four eyes needs two different administrators (ADR-0007 item 8, DK-04c): both sign in with the password of their class and
  // the secret of the console, both pass Kong and the adapter on an administrator's route, and they are two persons (`sub`).
  // The route is Privacy's, so only the proposed condition has it (the baseline has no Privacy Service).
  if (mode === 'proposed') {
    const auditLog = (token) => call(port, { url: '/audit-log?limit=1', headers: bearer(token), tls: verified });
    const [adminOne, adminTwo] = await Promise.all([mintToken('admin.uji.1'), mintToken('admin.uji.2')]);
    const subOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
    add('four eyes: the first administrator is let in on an administrator route', (await auditLog(adminOne)).status, 200);
    add('four eyes: the second administrator is let in on the same route', (await auditLog(adminTwo)).status, 200);
    add('four eyes: the two administrators are two different persons', subOf(adminOne) !== subOf(adminTwo), true);
    add('four eyes: an analyst is not let in on an administrator route', refused(await auditLog(analyst)), '403 ACCESS_DENIED');
  }

  // Same claims, another key: re-sign a valid payload with a key that Kong does not know. Kong must refuse it itself.
  const [h, p] = analyst.split('.');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signed = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  const foreign = edgeOnly(await held(`${h}.${p}.${signed}`));
  add('a token signed by another key, with the claims of a valid one', refused(foreign), '401 UNAUTHENTICATED');

  // A person with two roles, made through the Admin API with the client idp-admin (the path the registration uses) and removed
  // again. Which pair of roles idp-admin may give is part of what is checked: a role of a person who approves or audits is a
  // privilege it should not have.
  const admin = await serviceToken('idp-admin');
  const base = '/admin/realms/privpay';
  const name = `ganda.uji.${String(Date.now()).slice(-8)}`;
  let userId;
  try {
    const made = await idpCall('POST', `${base}/users`, { token: admin, json: { username: name, enabled: true, credentials: [{ type: 'password', value: classPassword('admin'), temporary: false }] } });
    const found = await idpCall('GET', `${base}/users?username=${name}&exact=true`, { token: admin });
    userId = Array.isArray(found.json) ? found.json[0]?.id : undefined;
    const statuses = [];
    for (const role of ['fraud_analyst', 'auditor', 'admin']) {
      const rep = await idpCall('GET', `${base}/roles/${role}`, { token: admin });
      const mapped = await idpCall('POST', `${base}/users/${userId}/role-mappings/realm`, { token: admin, json: [rep.json] });
      statuses.push(`${role}:${mapped.status}`);
    }
    add('idp-admin may give fraud_analyst and auditor but not admin (made: ' + made.status + ')', statuses.join(' '), 'fraud_analyst:204 auditor:204 admin:403');
    add('a person with two or more roles is refused by the adapter', refused(await held(await mintToken(name, 'admin-console', 'admin'))), '401 UNAUTHENTICATED');
  } finally {
    if (userId) await idpCall('DELETE', `${base}/users/${userId}`, { token: admin });
  }
  add('the token of the other key never reached the adapter (Kong stopped it)', adapterLog(mode).includes(foreign.id), false);
  return results;
}

async function limitChecks(port, ca) {
  const verified = { ca };
  const results = [];
  const add = (label, got, expected) => results.push([label, got, expected]);

  const token = await mintToken();
  let first;
  const codes = [];
  let retryAfter;
  let limited;
  for (let i = 0; i < 40; i += 1) {
    const answer = await call(port, { url: '/transaction/held', headers: bearer(token), tls: verified });
    first ??= answer.status;
    codes.push(answer.status);
    if (answer.status === 429) { limited = answer; retryAfter = answer.headers['retry-after']; break; }
  }
  add('the first requests pass', first, 200);
  add('past the limit: 429 RATE_LIMITED in the one shape', limited ? refused(limited) : `never limited in ${codes.length} requests`, '429 RATE_LIMITED');
  add('the refusal says when to come back (Retry-After)', /^[0-9]+$/.test(retryAfter ?? '') ? 'seconds' : String(retryAfter), 'seconds');
  add('the rate limit also counts the open /register route', refused(await call(port, { method: 'POST', url: '/register', body: {}, tls: verified })), '429 RATE_LIMITED');
  return results;
}

async function main() {
  const [mode, phase = 'base'] = process.argv.slice(2);
  if (!MODES.includes(mode) || !['base', 'expiry', 'limits', 'claims'].includes(phase)) {
    process.stderr.write('usage: edge-check.cjs <proposed|baseline> [base|expiry|limits|claims]\n');
    return 2;
  }
  const ca = fs.readFileSync(caFile());
  const port = PORTS[mode];
  const run = { base: () => baseChecks(mode, port, ca), expiry: () => expiryChecks(mode, port, ca), claims: () => claimChecks(mode, port, ca), limits: () => limitChecks(port, ca) };
  const results = await run[phase]();
  let failed = 0;
  for (const [label, got, expected] of results) {
    const ok = expected instanceof RegExp ? expected.test(String(got)) : got === expected;
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   (got: ${String(got)})`}\n`);
  }
  process.stdout.write(failed === 0 ? 'all checks passed\n' : `${String(failed)} check(s) failed\n`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${error instanceof Error ? error.message : 'error'}\n`); process.exitCode = 1; });
