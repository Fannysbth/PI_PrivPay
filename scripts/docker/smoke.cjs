'use strict';
// Compose smoke (DK-01a): register, pay, and list what is held, all through the Gateway, from inside the Compose network
// (the IdP and the SMS simulator are not published, `pnpm docker:smoke`). Same flow in both conditions. Every value below is
// invented; the script prints verdicts and counts only, never a token, an identity or a response body.
const { randomUUID } = require('node:crypto');

const GATEWAY = process.env.GATEWAY_URL;
const IDP = process.env.IDP_URL;
const SMS = process.env.SMS_URL;
const MODE = process.env.PRIVACY_MODE;
for (const [name, value] of Object.entries({ GATEWAY_URL: GATEWAY, IDP_URL: IDP, SMS_URL: SMS, PRIVACY_MODE: MODE })) {
  if (value === undefined || value === '') throw new Error(`${name} is required`);
}

const checks = [];
function check(name, ok) {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
}

async function call(method, url, { token, body, headers } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

// DK-04: Keycloak signs a user in by password grant (the one test password is read from a file, never printed); the dev IdP by name.
const KEYCLOAK = process.env.IDP_KIND === 'keycloak';
const userPassword = KEYCLOAK ? require('node:fs').readFileSync(process.env.IDP_USER_PASSWORD_FILE, 'utf8').trim() : undefined;
const login = async (client, username) => {
  if (!KEYCLOAK) {
    return (await call('POST', `${IDP}/token`, { body: { grant_type: 'dev_login', client_id: client, username } })).json
      ?.access_token;
  }
  const response = await fetch(`${IDP}/realms/${process.env.IDP_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: client, username, password: userPassword }).toString(),
  });
  return (await response.json().catch(() => undefined))?.access_token;
};

async function main() {
  // The mode the Gateway reports must be the one Compose chose (E-08).
  const health = await call('GET', `${GATEWAY}/health`);
  check(`gateway is healthy and reports mode ${MODE}`, health.status === 200 && health.json?.mode === MODE);

  // A person who does not exist yet, made of invented digits; the suffix keeps a second run from meeting the first.
  const n = String(Date.now() % 1_000_000).padStart(6, '0');
  const person = {
    nik: `99995${n}00000`.slice(0, 16),
    // A name takes letters only (registration.ts): the digits become letters.
    nama: `Kenari Smoke ${[...n].map((d) => 'abcdefghij'[Number(d)]).join('')}`,
    hp: `08999${n}0`,
    email: `canary-smoke-${n}@example.test`,
    rekening: `9999${n}`,
    username: `smoke.uji.${n}`,
  };
  const registered = await call('POST', `${GATEWAY}/register`, { body: person });
  check('register through the Gateway is 201', registered.status === 201);
  const leaked = [person.nik, person.nama, person.hp, person.email, person.rekening].filter((v) =>
    registered.text.includes(v),
  );
  check('the answer to register carries nothing of the form', leaked.length === 0);

  const token = await login('customer-app', person.username);
  check('the new customer can sign in at the IdP', typeof token === 'string');

  const pay = (amount, geohash) =>
    call('POST', `${GATEWAY}/transaction`, {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { source_account: person.rekening, merchant_id: 'MRC-001', amount, geohash },
    });

  const normal = await pay(35_000, 'qqgu4');
  check('a normal payment completes', normal.status === 201 && normal.json?.status === 'COMPLETED');

  await pay(2_000_000, 'qqgu7'); // history for Fraud, as in PRD 16 h01
  const suspicious = await pay(8_000_000, 'qqt8h');
  check('a suspicious payment is held', suspicious.status === 201 && suspicious.json?.status === 'HELD');

  const analyst = await login('admin-console', 'analis.uji.1');
  const held = await call('GET', `${GATEWAY}/transaction/held`, { token: analyst });
  const items = Array.isArray(held.json?.items) ? held.json.items : [];
  check(
    'the analyst sees the held payment in the list',
    held.status === 200 && items.some((item) => item.transaction_id === suspicious.json?.transaction_id),
  );
  check(
    'the held list carries no token, account or username',
    !/PSEU-|CUST-|smoke\.uji/.test(held.text) && !held.text.includes(person.rekening),
  );

  const messages = await call('GET', `${SMS}/__test/messages`);
  check(
    'the SMS simulator got at least one message',
    messages.status === 200 && Array.isArray(messages.json?.messages) && messages.json.messages.length >= 1,
  );

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`${String(checks.length - failed.length)}/${String(checks.length)} checks passed (mode ${MODE})\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  // The kind of error only: a message could carry an address or a body.
  process.stderr.write(`smoke failed: ${error instanceof Error ? error.name : 'error'}\n`);
  process.exitCode = 1;
});
