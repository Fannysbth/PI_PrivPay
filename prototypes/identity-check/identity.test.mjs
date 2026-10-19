// THROWAWAY (Phase 2 check b): does ADR-0007 (two tokens) keep requesting_service strictly from the service token?
// Hand-rolled RS256 with node:crypto only, for the experiment. Not production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const idp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = 1_800_000_000;

function sign(claims, { key = idp.privateKey, alg = 'RS256', kid = 'dev-1' } = {}) {
  const head = b64({ alg, typ: 'JWT', kid });
  const body = b64(claims);
  if (alg === 'none') return `${head}.${body}.`;
  if (alg === 'HS256') return `${head}.${body}.${b64('forged')}`;
  const s = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${s.toString('base64url')}`;
}
const claims = (over) => ({ iss: 'privpay-dev-idp', aud: ['privacy-service'], iat: NOW, exp: NOW + 300, ...over });

const SERVICE_AZP = {
  'api-gateway': 'API_GATEWAY', transaction: 'TRANSACTION', fraud: 'FRAUD',
  notification: 'NOTIFICATION', reconciliation: 'RECONCILIATION', 'admin-console': 'ADMIN_CONSOLE', 'bank-simulator': 'BANK',
};
const HUMAN_ROLES = ['admin', 'auditor', 'fraud_analyst'];
// Table 3 subset (+ ADR-0007 item 2 for human operations served directly by Privacy).
const CALLERS = { DE_PSEUDONYMIZE: ['RECONCILIATION'], GENERATE_FROM_IDENTITY: ['API_GATEWAY'], REVOKE_TOKEN: ['ADMIN_CONSOLE'] };

class AuthError extends Error { constructor(reason) { super(reason); this.reason = reason; } }

function verify(token, now = NOW) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new AuthError('MALFORMED');
  const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (head.alg !== 'RS256') throw new AuthError('ALG');
  const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(idp.publicKey, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new AuthError('SIGNATURE');
  const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (c.iss !== 'privpay-dev-idp') throw new AuthError('ISS');
  if (!(c.exp > now)) throw new AuthError('EXPIRED');
  if (!Array.isArray(c.aud) || !c.aud.includes('privacy-service')) throw new AuthError('AUD');
  return c;
}

// requesting_service comes ONLY from Authorization.azp; the actor token only yields actor_id and role.
function authenticate({ authorization, actorToken, body }) {
  void body; // a body-supplied requesting_service is never read (D-16)
  const bearer = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!bearer) throw new AuthError('NO_AUTH');
  const c = verify(bearer[1]);
  const requestingService = SERVICE_AZP[c.azp];
  if (!requestingService) throw new AuthError('AZP_NOT_ALLOWED');
  if (requestingService === 'ADMIN_CONSOLE') {
    if (actorToken) throw new AuthError('ACTOR_TOKEN_NOT_ALLOWED'); // human token is already the caller
    return { requestingService, actor: humanActor(c) };
  }
  if (!actorToken) return { requestingService, actor: null };
  return { requestingService, actor: humanActor(verify(actorToken)) };
}
function humanActor(c) {
  if (c.azp !== 'admin-console') throw new AuthError('ACTOR_NOT_HUMAN_CLIENT');
  const roles = (c.roles ?? []).filter((r) => HUMAN_ROLES.includes(r));
  if (roles.length !== 1 || (c.roles ?? []).length !== 1) throw new AuthError('ACTOR_ROLE');
  if (!c.sub) throw new AuthError('ACTOR_SUB');
  return { actorId: c.sub, role: roles[0] };
}
function authorize(op, ctx, needActorRole) {
  if (!CALLERS[op].includes(ctx.requestingService)) throw new AuthError('POLICY_NOT_ALLOWED');
  if (needActorRole && ctx.actor?.role !== needActorRole) throw new AuthError('FORBIDDEN_ROLE');
}

const svc = (azp, over) => `Bearer ${sign(claims({ azp, sub: `svc-${azp}`, ...over }))}`;
const human = (over) => sign(claims({ azp: 'admin-console', sub: 'usr-auditor-01', roles: ['auditor'], ...over }));
const reason = (fn) => { try { fn(); } catch (e) { return e.reason ?? e.message; } return 'NO_ERROR'; };

test('FR-09/D-16 requesting_service is taken from the service token azp, with a valid actor token alongside', () => {
  const ctx = authenticate({ authorization: svc('reconciliation'), actorToken: human() });
  assert.equal(ctx.requestingService, 'RECONCILIATION');
  assert.deepEqual(ctx.actor, { actorId: 'usr-auditor-01', role: 'auditor' });
  authorize('DE_PSEUDONYMIZE', ctx, 'auditor');
});

test('TK-07 a requesting_service in the body is ignored', () => {
  const ctx = authenticate({ authorization: svc('transaction'), body: { requesting_service: 'RECONCILIATION' } });
  assert.equal(ctx.requestingService, 'TRANSACTION');
  assert.equal(reason(() => authorize('DE_PSEUDONYMIZE', ctx, null)), 'POLICY_NOT_ALLOWED');
});

test('ADR-0007 an actor token claiming a service azp or requesting_service cannot change the caller', () => {
  const forged = sign(claims({ azp: 'reconciliation', requesting_service: 'RECONCILIATION', sub: 'x', roles: ['auditor'] }));
  assert.equal(reason(() => authenticate({ authorization: svc('transaction'), actorToken: forged })), 'ACTOR_NOT_HUMAN_CLIENT');
});

test('ADR-0007 a service token used as the actor token is rejected', () => {
  const serviceAsActor = sign(claims({ azp: 'reconciliation', sub: 'svc-reconciliation' }));
  assert.equal(reason(() => authenticate({ authorization: svc('transaction'), actorToken: serviceAsActor })), 'ACTOR_NOT_HUMAN_CLIENT');
});

test('ADR-0007 a customer token (customer-app) is rejected as actor token and as Authorization', () => {
  const customer = sign(claims({ azp: 'customer-app', sub: 'u', customer_id: 'CUST-000101', roles: [] }));
  assert.equal(reason(() => authenticate({ authorization: svc('transaction'), actorToken: customer })), 'ACTOR_NOT_HUMAN_CLIENT');
  assert.equal(reason(() => authenticate({ authorization: `Bearer ${customer}` })), 'AZP_NOT_ALLOWED');
});

test('TK-08 de-pseudonymize without an actor token or without auditor role is denied', () => {
  const noActor = authenticate({ authorization: svc('reconciliation') });
  assert.equal(reason(() => authorize('DE_PSEUDONYMIZE', noActor, 'auditor')), 'FORBIDDEN_ROLE');
  const adminActor = authenticate({ authorization: svc('reconciliation'), actorToken: human({ roles: ['admin'], sub: 'usr-admin-01' }) });
  assert.equal(reason(() => authorize('DE_PSEUDONYMIZE', adminActor, 'auditor')), 'FORBIDDEN_ROLE');
});

test('ADR-0007 a human token as Authorization yields ADMIN_CONSOLE and cannot call a service-only operation', () => {
  const ctx = authenticate({ authorization: `Bearer ${human()}` });
  assert.equal(ctx.requestingService, 'ADMIN_CONSOLE');
  assert.equal(reason(() => authorize('DE_PSEUDONYMIZE', ctx, 'auditor')), 'POLICY_NOT_ALLOWED');
  authorize('REVOKE_TOKEN', { ...ctx, actor: { actorId: 'usr-admin-01', role: 'admin' } }, 'admin');
});

test('ADR-0007 an actor token next to a human Authorization is rejected (no double identity)', () => {
  assert.equal(reason(() => authenticate({ authorization: `Bearer ${human()}`, actorToken: human() })), 'ACTOR_TOKEN_NOT_ALLOWED');
});

test('NFR-21 expired, wrong audience, wrong signer, alg none and alg HS256 are rejected for both tokens', () => {
  const bad = {
    EXPIRED: { exp: NOW - 1 },
    AUD: { aud: ['transaction-service'] },
  };
  for (const [why, over] of Object.entries(bad)) {
    assert.equal(reason(() => authenticate({ authorization: svc('transaction', over) })), why);
    assert.equal(reason(() => authenticate({ authorization: svc('transaction'), actorToken: human(over) })), why);
  }
  const wrongSigner = sign(claims({ azp: 'transaction', sub: 's' }), { key: rogue.privateKey });
  assert.equal(reason(() => authenticate({ authorization: `Bearer ${wrongSigner}` })), 'SIGNATURE');
  for (const alg of ['none', 'HS256']) {
    const t = sign(claims({ azp: 'transaction', sub: 's' }), { alg });
    assert.equal(reason(() => authenticate({ authorization: `Bearer ${t}` })), 'ALG');
    assert.equal(reason(() => authenticate({ authorization: svc('transaction'), actorToken: sign(claims({ azp: 'admin-console', sub: 'h', roles: ['auditor'] }), { alg }) })), 'ALG');
  }
});

test('ADR-0007 one role per human: zero or several roles are rejected', () => {
  for (const roles of [[], ['auditor', 'admin']]) {
    assert.equal(reason(() => authenticate({ authorization: svc('reconciliation'), actorToken: human({ roles }) })), 'ACTOR_ROLE');
  }
});
