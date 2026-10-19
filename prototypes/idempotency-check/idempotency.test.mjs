// THROWAWAY (Phase 2 check a): can ADR-0009 (no secret fingerprint) still let TF-08 test "different body -> 409"?
// Models only what matters: gateway tokenization with TTL reuse (PRD 7.1) and Transaction's replay comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

class Clock {
  constructor() { this.ms = Date.UTC(2026, 9, 5, 12, 0, 0); }
  now() { return this.ms; }
  advance(seconds) { this.ms += seconds * 1000; }
}

// Stand-in for Privacy Service buat_token: reuse active token for (type, subject, service, purpose) until TTL.
class Tokenizer {
  constructor(clock, ttlSeconds) { this.clock = clock; this.ttl = ttlSeconds; this.active = new Map(); }
  issue(type, subject) {
    const key = `${type}|${subject}|TRANSACTION|PAYMENT_PROCESSING`;
    const cur = this.active.get(key);
    if (cur && this.clock.now() < cur.expiresAt) return cur.pseudonym;
    const pseudonym = 'PSEU-' + randomBytes(4).toString('hex').toUpperCase();
    this.active.set(key, { pseudonym, expiresAt: this.clock.now() + this.ttl * 1000 });
    return pseudonym;
  }
}

// Transaction-service side of ADR-0009: unique idempotency_key + field comparison, no hashes of raw identity.
class Transactions {
  constructor() { this.rows = new Map(); this.seq = 0; }
  create(req) {
    const row = this.rows.get(req.idempotency_key);
    if (!row) {
      const created = { transaction_id: req.transaction_id, status: 'COMPLETED', ...pick(req) };
      this.rows.set(req.idempotency_key, created);
      return { http: 201, body: { transaction_id: created.transaction_id, status: created.status } };
    }
    const same = Object.keys(pick(req)).every((k) => row[k] === req[k]);
    return same
      ? { http: 200, body: { transaction_id: row.transaction_id, status: row.status } }
      : { http: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } };
  }
  reissue(idempotencyKey, customerToken, accountToken) {
    const row = this.rows.get(idempotencyKey);
    row.customer_token = customerToken;
    row.account_token = accountToken;
  }
}
const pick = (r) => ({
  customer_token: r.customer_token, account_token: r.account_token,
  merchant_id: r.merchant_id, amount: r.amount, geohash: r.geohash,
});

function setup() {
  const clock = new Clock();
  const tokenizer = new Tokenizer(clock, 900);
  const txs = new Transactions();
  let n = 10000;
  // Gateway: tokenizes (customer_id from JWT claim, raw account from body); Transaction never sees raw values.
  const post = (customerId, body, key) => txs.create({
    transaction_id: `TX-${++n}`, idempotency_key: key,
    customer_token: tokenizer.issue('CUSTOMER', customerId),
    account_token: tokenizer.issue('ACCOUNT', body.source_account),
    merchant_id: body.merchant_id, amount: body.amount, geohash: body.geohash,
  });
  return { clock, tokenizer, txs, post };
}

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const body = { source_account: '1234567801', merchant_id: 'MRC-001', amount: 35000, geohash: 'qqgu4' };

test('TF-08 same key + same body replays 200 with the original transaction_id and creates one row', () => {
  const { post, txs } = setup();
  const first = post('CUST-000101', body, KEY);
  const again = post('CUST-000101', body, KEY);
  assert.equal(first.http, 201);
  assert.equal(again.http, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(txs.rows.size, 1);
});

for (const [name, change] of [
  ['amount', { amount: 36000 }],
  ['merchant_id', { merchant_id: 'MRC-002' }],
  ['geohash', { geohash: 'qqt8h' }],
  ['source_account (same customer, other account)', { source_account: '1234567899' }],
]) {
  test(`TF-08 same key + different ${name} -> 409 IDEMPOTENCY_CONFLICT`, () => {
    const { post, txs } = setup();
    post('CUST-000101', body, KEY);
    const res = post('CUST-000101', { ...body, ...change }, KEY);
    assert.equal(res.http, 409);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(txs.rows.size, 1);
  });
}

test('TF-08 same key from a different customer -> 409 and no data of the first customer is returned', () => {
  const { post } = setup();
  const first = post('CUST-000101', body, KEY);
  const res = post('CUST-000102', body, KEY);
  assert.equal(res.http, 409);
  assert.ok(!JSON.stringify(res.body).includes(first.body.transaction_id));
});

test('TF-08 replay after a mid-process re-issue within the window still matches (re-issue reuses the active token)', () => {
  const { post, txs, clock, tokenizer } = setup();
  const first = post('CUST-000101', body, KEY);
  clock.advance(901); // original tokens expire while the transaction is still open
  const newCustomer = tokenizer.issue('CUSTOMER', 'CUST-000101'); // re-issue (buat_token) -> new active token
  const newAccount = tokenizer.issue('ACCOUNT', body.source_account);
  txs.reissue(KEY, newCustomer, newAccount);
  const again = post('CUST-000101', body, KEY); // gateway tokenization returns the same active tokens
  assert.equal(again.http, 200);
  assert.equal(again.body.transaction_id, first.body.transaction_id);
});

test('ADR-0009 documented limit: replay after the token window without re-issue -> 409 (fails safe, no duplicate)', () => {
  const { post, txs, clock } = setup();
  post('CUST-000101', body, KEY);
  clock.advance(901);
  const res = post('CUST-000101', body, KEY);
  assert.equal(res.http, 409);
  assert.equal(txs.rows.size, 1);
});

test('ADR-0009 no raw identity or identity-derived fingerprint is stored with the transaction', () => {
  const { post, txs } = setup();
  post('CUST-000101', body, KEY);
  const stored = JSON.stringify([...txs.rows.values()]);
  assert.ok(!stored.includes('1234567801'));
  assert.ok(!stored.includes('CUST-000101'));
});
