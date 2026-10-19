// THROWAWAY P-3: AES-256-GCM with AAD, blind index, and lookup through subject_lookup on real PostgreSQL.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, newKeys } from './lib/db.mjs';
import { aadMapping, aadVault, decryptField, encodeParts, encryptField, loadKeys, subjectLookup, tokenValue } from './lib/crypto.mjs';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const keys = loadKeys(newKeys());
const versions = new Map([[1, keys.kField]]);
let db;
before(async () => { db = await createTestDb('privpay_privacy_test_p3', schema); });
after(async () => { await db?.close(); });

test('S-31 round trip, format key_version(2)||IV(12)||ct||tag(16), fresh random IV on every write', () => {
  const blob = encryptField(keys.kField, 1, 'CUST-000101', 'CUSTOMER');
  assert.equal(blob.length, 2 + 12 + Buffer.byteLength('CUST-000101') + 16);
  assert.equal(blob.readUInt16BE(0), 1);
  assert.equal(decryptField(versions, blob, 'CUSTOMER'), 'CUST-000101');
  const ivs = new Set();
  for (let i = 0; i < 2000; i++) ivs.add(encryptField(keys.kField, 1, 'CUST-000101', 'CUSTOMER').subarray(2, 14).toString('hex'));
  assert.equal(ivs.size, 2000);
  assert.notDeepEqual(encryptField(keys.kField, 1, 'x', 'CUSTOMER'), encryptField(keys.kField, 1, 'x', 'CUSTOMER'));
});

test('S-31 any modification of version, IV, ciphertext or tag is rejected', () => {
  const blob = encryptField(keys.kField, 1, 'CUST-000101', 'CUSTOMER');
  for (const i of [0, 1, 2, 13, 14, blob.length - 17, blob.length - 1]) {
    const bad = Buffer.from(blob); bad[i] ^= 0x01;
    assert.throws(() => decryptField(versions, bad, 'CUSTOMER'), `byte ${i}`);
  }
  assert.throws(() => decryptField(versions, blob.subarray(0, blob.length - 1), 'CUSTOMER'));
  assert.throws(() => decryptField(versions, Buffer.alloc(10), 'CUSTOMER'));
});

test('S-31 ciphertext cannot be moved across subject types (mapping) or across vault columns', () => {
  const asCustomer = encryptField(keys.kField, 1, 'CUST-000101', 'CUSTOMER');
  assert.throws(() => decryptField(versions, asCustomer, 'ACCOUNT'));
  const nik = encryptField(keys.kField, 1, '3273015501900001', 'nik');
  assert.throws(() => decryptField(versions, nik, 'nama'));
  assert.equal(decryptField(versions, nik, 'nik'), '3273015501900001');
});

test('FR-30/S-03 keys must be 32 bytes and pairwise different', () => {
  const k = newKeys();
  assert.throws(() => loadKeys({ ...k, kIndex: k.kToken }), /differ/);
  assert.throws(() => loadKeys({ ...k, kField: randomBytes(16) }), /32 bytes/);
  assert.throws(() => loadKeys({ ...k, kToken: Buffer.alloc(0) }), /32 bytes/);
});

test('blind index is deterministic, separated by subject type and key, and unrelated to the token value', () => {
  const a = subjectLookup(keys.kIndex, 'CUSTOMER', 'CUST-000101');
  assert.deepEqual(a, subjectLookup(keys.kIndex, 'CUSTOMER', 'CUST-000101'));
  assert.notDeepEqual(a, subjectLookup(keys.kIndex, 'ACCOUNT', 'CUST-000101'));
  assert.notDeepEqual(a, subjectLookup(newKeys().kIndex, 'CUSTOMER', 'CUST-000101'));
  assert.equal(a.length, 32);
  const t = tokenValue(keys.kToken, 'CUSTOMER', 'CUST-000101', 'TRANSACTION', 'PAYMENT_PROCESSING', 'n1');
  assert.match(t, /^PSEU-[0-9A-F]{8}$/);
  assert.notEqual(t, tokenValue(keys.kToken, 'CUSTOMER', 'CUST-000101', 'TRANSACTION', 'PAYMENT_PROCESSING', 'n2'));
});

test('PRD 6 "||" needs an unambiguous encoding: bare concatenation collides, the length-prefixed one does not', () => {
  const bare = (...p) => p.join('');
  assert.equal(bare('CUST-1', '2'), bare('CUST-12', ''));
  assert.notDeepEqual(encodeParts('CUST-1', '2'), encodeParts('CUST-12', ''));
});

test('FR-25/NFR-05 DB dump shows ciphertext only; lookup by subject_lookup finds and decrypts the row', async () => {
  const id = 'CUST-DUMP0001';
  const rowId = randomUUID();
  const lookup = subjectLookup(keys.kIndex, 'CUSTOMER', id);
  await db.app.query(
    `INSERT INTO pseudonym_mapping (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
     VALUES ($1, 'CUSTOMER', $2, $3, 'PSEU-D0000001', 'TRANSACTION', 'PAYMENT_PROCESSING', now() + interval '15 minutes')`,
    [rowId, encryptField(keys.kField, 1, id, aadMapping('CUSTOMER', rowId)), lookup]);
  const raw = (await db.owner.query(`SELECT subject_id_enc FROM pseudonym_mapping WHERE pseudonym = 'PSEU-D0000001'`)).rows[0].subject_id_enc;
  assert.ok(!raw.includes(Buffer.from(id)));
  const found = await db.app.query(
    `SELECT id, subject_id_enc FROM pseudonym_mapping WHERE subject_lookup = $1 AND service_id = 'TRANSACTION' AND purpose = 'PAYMENT_PROCESSING' AND status = 'active'`, [lookup]);
  assert.equal(found.rowCount, 1);
  assert.equal(decryptField(versions, found.rows[0].subject_id_enc, aadMapping('CUSTOMER', found.rows[0].id)), id);
});

test('NFR-04 the main lookups use an index, not a sequential scan, on a 20k-row table (default planner settings)', async () => {
  const BATCH = 2000;
  for (let b = 0; b < 10; b++) {
    const values = []; const params = [];
    for (let i = 0; i < BATCH; i++) {
      const n = b * BATCH + i;
      params.push(subjectLookup(keys.kIndex, 'CUSTOMER', `CUST-BULK${n}`), `PSEU-${n.toString(16).toUpperCase().padStart(8, '0')}`);
      values.push(`('CUSTOMER', $${params.length - 1}, $${params.length}, 'TRANSACTION', 'FRAUD_DETECTION', now() + interval '1 day')`);
    }
    await db.app.query(`INSERT INTO pseudonym_mapping (subject_type, subject_lookup, pseudonym, service_id, purpose, expires_at) VALUES ${values.join(',')}`, params);
  }
  await db.owner.query('ANALYZE pseudonym_mapping');
  const plan = async (sql, params) => JSON.stringify((await db.app.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN']);
  const byLookup = await plan(`SELECT id FROM pseudonym_mapping WHERE subject_lookup = $1 AND service_id = 'TRANSACTION' AND purpose = 'FRAUD_DETECTION' AND status = 'active'`, [subjectLookup(keys.kIndex, 'CUSTOMER', 'CUST-BULK77')]);
  const byPseudonym = await plan(`SELECT id FROM pseudonym_mapping WHERE pseudonym = $1`, ['PSEU-0000004D']);
  assert.ok(!byLookup.includes('Seq Scan'), byLookup);
  assert.ok(!byPseudonym.includes('Seq Scan'), byPseudonym);
});

test('FR-31/chk_purged purging must clear both identity columns; a half-purge is rejected by the database', async () => {
  const code = (sql, p) => db.owner.query(sql, p).then(() => 'OK', (e) => e.code);
  assert.equal(await code(`UPDATE pseudonym_mapping SET purged_at = now() WHERE pseudonym = 'PSEU-D0000001'`), '23514');
  assert.equal(await code(`UPDATE pseudonym_mapping SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = now() WHERE pseudonym = 'PSEU-D0000001'`), 'OK');
});

test('D-13 rotating K_index only changes subject_lookup: the row-bound ciphertext still decrypts', async () => {
  const rowId = randomUUID();
  const enc = encryptField(keys.kField, 1, 'CUST-ROT00001', aadMapping('CUSTOMER', rowId));
  await db.app.query(
    `INSERT INTO pseudonym_mapping (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
     VALUES ($1, 'CUSTOMER', $2, $3, 'PSEU-R0000001', 'TRANSACTION', 'PAYMENT_PROCESSING', now() + interval '15 minutes')`,
    [rowId, enc, subjectLookup(keys.kIndex, 'CUSTOMER', 'CUST-ROT00001')]);
  await db.owner.query(`UPDATE pseudonym_mapping SET subject_lookup = $2 WHERE id = $1`,
    [rowId, subjectLookup(newKeys().kIndex, 'CUSTOMER', 'CUST-ROT00001')]);
  const { rows } = await db.app.query('SELECT subject_id_enc FROM pseudonym_mapping WHERE id = $1', [rowId]);
  assert.equal(decryptField(versions, rows[0].subject_id_enc, aadMapping('CUSTOMER', rowId)), 'CUST-ROT00001');
});

test('E-06 audit_log.attribute_names only accepts the Table 5 attribute names, never free text', async () => {
  const insert = (attrs) => db.app.query(
    `INSERT INTO audit_log (action, status, reason, requesting_service, attribute_names) VALUES ('DE_PSEUDONYMIZE','SUCCESS','OK','RECONCILIATION',$1)`, [attrs]).then(() => 'OK', (e) => e.code);
  assert.equal(await insert(['nama']), 'OK');
  assert.equal(await insert(['customer_id', 'nik', 'nama']), 'OK');
  assert.equal(await insert(['hp']), '23514');
  assert.equal(await insert(['Budi Santoso']), '23514');
});

const [rowA, rowB] = [randomUUID(), randomUUID()];

test('S-31 mapping ciphertext is bound to its row id: a same-type ciphertext moved to another row is rejected', () => {
  const blobB = encryptField(keys.kField, 1, 'CUST-000102', aadMapping('CUSTOMER', rowB));
  assert.equal(decryptField(versions, blobB, aadMapping('CUSTOMER', rowB)), 'CUST-000102');
  assert.throws(() => decryptField(versions, blobB, aadMapping('CUSTOMER', rowA)));
  assert.throws(() => decryptField(versions, blobB, aadMapping('ACCOUNT', rowB)));
});

test('S-31 vault ciphertext is bound to column and row: moved across customers or across columns is rejected', () => {
  const nik = encryptField(keys.kField, 1, '3273015501900001', aadVault('nik', rowA));
  assert.equal(decryptField(versions, nik, aadVault('nik', rowA)), '3273015501900001');
  assert.throws(() => decryptField(versions, nik, aadVault('nik', rowB)));
  assert.throws(() => decryptField(versions, nik, aadVault('nama', rowA)));
});

test('AAD encoding is unambiguous across domain, column/type and row id', () => {
  const seen = new Set([
    aadMapping('CUSTOMER', 'x'), aadMapping('ACCOUNT', 'x'), aadVault('nik', 'x'), aadVault('ni', 'kx'),
    aadVault('nik', 'y'), aadMapping('CUSTOMERx', ''),
  ].map((b) => b.toString('hex')));
  assert.equal(seen.size, 6);
});

test('S-31 swapping ciphertext between rows or columns directly in the database is detected on read (real roles)', async () => {
  const [m1, m2, v1, v2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const mapping = (id, subject, pseudonym) => db.app.query(
    `INSERT INTO pseudonym_mapping (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
     VALUES ($1, 'CUSTOMER', $2, $3, $4, 'TRANSACTION', 'PAYMENT_PROCESSING', now() + interval '15 minutes')`,
    [id, encryptField(keys.kField, 1, subject, aadMapping('CUSTOMER', id)), subjectLookup(keys.kIndex, 'CUSTOMER', subject), pseudonym]);
  await mapping(m1, 'CUST-SWAP0001', 'PSEU-5A000001');
  await mapping(m2, 'CUST-SWAP0002', 'PSEU-5A000002');
  const vault = (id, nik, nama) => db.app.query(
    `INSERT INTO identity_vault (id, nik_enc, nama_enc) VALUES ($1, $2, $3)`,
    [id, encryptField(keys.kField, 1, nik, aadVault('nik', id)), encryptField(keys.kField, 1, nama, aadVault('nama', id))]);
  await vault(v1, '3273015501900001', 'Rina Wijaya');
  await vault(v2, '3273012203880002', 'Budi Santoso');

  const readMapping = async (id) => decryptField(versions, (await db.app.query('SELECT subject_id_enc FROM pseudonym_mapping WHERE id = $1', [id])).rows[0].subject_id_enc, aadMapping('CUSTOMER', id));
  const readVault = async (id, column) => decryptField(versions, (await db.app.query(`SELECT ${column}_enc AS c FROM identity_vault WHERE id = $1`, [id])).rows[0].c, aadVault(column, id));
  assert.equal(await readMapping(m1), 'CUST-SWAP0001');
  assert.equal(await readVault(v1, 'nik'), '3273015501900001');

  await db.owner.query(
    `UPDATE pseudonym_mapping SET subject_id_enc = CASE id WHEN $1 THEN (SELECT subject_id_enc FROM pseudonym_mapping WHERE id = $2)
                                                          ELSE (SELECT subject_id_enc FROM pseudonym_mapping WHERE id = $1) END
     WHERE id IN ($1, $2)`, [m1, m2]);
  await assert.rejects(readMapping(m1));
  await assert.rejects(readMapping(m2));

  await db.owner.query(`UPDATE identity_vault SET nik_enc = nama_enc, nama_enc = nik_enc WHERE id = $1`, [v1]);
  await assert.rejects(readVault(v1, 'nik'));
  await assert.rejects(readVault(v1, 'nama'));
  await db.owner.query(`UPDATE identity_vault SET nik_enc = (SELECT nik_enc FROM identity_vault WHERE id = $2) WHERE id = $1`, [v1, v2]);
  await assert.rejects(readVault(v1, 'nik'));
});
