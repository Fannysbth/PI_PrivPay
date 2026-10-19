// THROWAWAY P-2: buat_token under parallel load on real PostgreSQL, connecting as the real runtime roles.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Clock, createTestDb, newKeys } from './lib/db.mjs';
import { buatToken } from './lib/buat-token.mjs';
import { loadKeys, subjectLookup, tokenValue } from './lib/crypto.mjs';

const CONC = Number(process.env.P2_CONCURRENCY ?? 50);
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
let db;
const keys = loadKeys(newKeys());

before(async () => { db = await createTestDb('privpay_privacy_test_p2', schema); });
after(async () => { await db?.close(); });

const req = (over = {}) => ({
  subjectType: 'CUSTOMER', subjectId: 'CUST-000101', serviceId: 'TRANSACTION',
  purpose: 'PAYMENT_PROCESSING', ttlSeconds: 900, ...over,
});
const parallel = (n, fn) => Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
const activeRows = async (lookupHex) =>
  (await db.owner.query(
    `SELECT count(*)::int AS n FROM pseudonym_mapping WHERE status = 'active' AND encode(subject_lookup,'hex') = $1`, [lookupHex])).rows[0].n;

for (const strategy of ['B', 'C']) {
  test(`TF-07/C-03 [strategy ${strategy}] ${CONC} parallel identical requests: one reused:false, the rest reused:true, one active row, no errors`, async () => {
    const clock = new Clock();
    for (let round = 0; round < 5; round++) {
      const subjectId = `CUST-${strategy}${round}0001`;
      const settled = await parallel(CONC, () => buatToken(db.app, keys, req({ subjectId }), { strategy, clock }));
      const failed = settled.filter((s) => s.status === 'rejected');
      assert.equal(failed.length, 0, `errors: ${failed.map((f) => f.reason.code ?? f.reason.message).join(',')}`);
      const ok = settled.map((s) => s.value);
      assert.equal(ok.filter((r) => !r.reused).length, 1);
      assert.equal(ok.filter((r) => r.reused).length, CONC - 1);
      assert.equal(new Set(ok.map((r) => r.pseudonym)).size, 1);
      assert.equal(await activeRows(subjectLookup(keys.kIndex, 'CUSTOMER', subjectId).toString('hex')), 1);
    }
  });

  test(`TF-15/C-02 [strategy ${strategy}] after TTL ${CONC} parallel requests issue exactly one new token without unique violations`, async () => {
    const clock = new Clock();
    const subjectId = `CUST-${strategy}TTL001`;
    const first = await buatToken(db.app, keys, req({ subjectId }), { strategy, clock });
    clock.advance(901);
    const settled = await parallel(CONC, () => buatToken(db.app, keys, req({ subjectId }), { strategy, clock }));
    assert.equal(settled.filter((s) => s.status === 'rejected').length, 0);
    const ok = settled.map((s) => s.value);
    assert.equal(ok.filter((r) => !r.reused).length, 1);
    assert.notEqual(ok[0].pseudonym, first.pseudonym);
    const { rows } = await db.owner.query(
      `SELECT status, count(*)::int AS n FROM pseudonym_mapping WHERE pseudonym = ANY($1) GROUP BY status`,
      [[first.pseudonym, ok[0].pseudonym]]);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.status, r.n])), { expired: 1, active: 1 });
  });
}

test('P-2 guard: without the advisory lock (strategy A) the same parallel scenario is rejected by uq_mapping_active', async () => {
  const clock = new Clock();
  const rejections = [];
  for (let round = 0; round < 10 && rejections.length === 0; round++) {
    const subjectId = `CUST-GUARD${round}`;
    const settled = await parallel(CONC, () => buatToken(db.app, keys, req({ subjectId }), { strategy: 'A', clock }));
    rejections.push(...settled.filter((s) => s.status === 'rejected').map((s) => s.reason));
  }
  assert.ok(rejections.length > 0, 'strategy A never failed: the concurrency tests would not notice a missing lock');
  assert.ok(rejections.every((e) => e.code === '23505' && e.constraint === 'uq_mapping_active'));
});

test('FR-05 one subject gets different tokens per service/purpose; different subjects get different tokens (parallel)', async () => {
  const clock = new Clock();
  const combos = [['TRANSACTION', 'PAYMENT_PROCESSING'], ['FRAUD', 'FRAUD_DETECTION'], ['NOTIFICATION', 'NOTIFICATION'], ['NOTIFICATION', 'NOTIFICATION_REGISTRATION']];
  const settled = await parallel(combos.length * 5, (i) => {
    const [serviceId, purpose] = combos[i % combos.length];
    return buatToken(db.app, keys, req({ subjectId: 'CUST-000777', serviceId, purpose }), { strategy: 'C', clock });
  });
  assert.ok(settled.every((s) => s.status === 'fulfilled'));
  const byCombo = new Map();
  settled.forEach((s, i) => byCombo.set(i % combos.length, new Set([...(byCombo.get(i % combos.length) ?? []), s.value.pseudonym])));
  assert.ok([...byCombo.values()].every((s) => s.size === 1));
  assert.equal(new Set([...byCombo.values()].map((s) => [...s][0])).size, combos.length);
});

test('C-04 a pseudonym collision is retried from a fresh nonce until it succeeds (no aborted transaction)', async () => {
  const clock = new Clock();
  const collide = { n: 0 };
  // Seed a row that owns PSEU-AAAAAAAA, then force the next three attempts to produce it again.
  await buatToken(db.app, keys, req({ subjectId: 'CUST-COLL001' }), { strategy: 'C', clock, tokenFn: () => 'PSEU-AAAAAAAA' });
  const res = await buatToken(db.app, keys, req({ subjectId: 'CUST-COLL002' }), {
    strategy: 'C', clock,
    tokenFn: (...a) => (++collide.n <= 3 ? 'PSEU-AAAAAAAA' : tokenValue(...a.slice(0, 6))),
  });
  assert.equal(res.attempts, 4);
  assert.notEqual(res.pseudonym, 'PSEU-AAAAAAAA');
});

test('TK-10/S-34 audit_log is append-only for the runtime role and read-only for the auditor role (real roles)', async () => {
  await db.app.query(`INSERT INTO audit_log (action, status, reason, requesting_service) VALUES ('GENERATE_TOKEN','SUCCESS','OK','API_GATEWAY')`);
  const code = async (pool, sql) => pool.query(sql).then(() => 'OK', (e) => e.code);
  assert.equal(await code(db.app, `UPDATE audit_log SET reason = 'X'`), '42501');
  assert.equal(await code(db.app, `DELETE FROM audit_log`), '42501');
  assert.equal(await code(db.app, `TRUNCATE audit_log`), '42501');
  assert.equal(await code(db.auditor, `UPDATE audit_log SET reason = 'X'`), '42501');
  assert.equal(await code(db.auditor, `DELETE FROM audit_log`), '42501');
  assert.equal(await code(db.auditor, `INSERT INTO audit_log (action, status, reason, requesting_service) VALUES ('A','DENIED','X','Y')`), '42501');
  assert.equal(await code(db.auditor, `SELECT count(*) FROM audit_log`), 'OK');
});

test('S-35 the auditor role cannot read identity_vault or the mapping table; the runtime role cannot read audit_log', async () => {
  const code = async (pool, sql) => pool.query(sql).then(() => 'OK', (e) => e.code);
  assert.equal(await code(db.auditor, `SELECT * FROM identity_vault`), '42501');
  assert.equal(await code(db.auditor, `SELECT * FROM pseudonym_mapping`), '42501');
  assert.equal(await code(db.app, `SELECT * FROM audit_log`), '42501');
});

test('TK-24/S-22 chk_four_eyes rejects approver = requester even when written directly as the runtime role', async () => {
  const { mappingId } = await buatToken(db.app, keys, req({ subjectId: 'CUST-4EYES01', serviceId: 'RECONCILIATION', purpose: 'INTERNAL_AUDIT', ttlSeconds: 600 }), { strategy: 'C', clock: new Clock() });
  const insert = (approver) => db.app.query(
    `INSERT INTO disclosure_request (mapping_id, basis, case_ref, requested_attrs, requester_id, approver_id) VALUES ($1,'DISPUTE','KASUS-2026-014','{nama}','usr-auditor-01',$2)`,
    [mappingId, approver]).then(() => 'OK', (e) => e.code);
  assert.equal(await insert('usr-auditor-01'), '23514');
  assert.equal(await insert('usr-admin-01'), 'OK');
});
