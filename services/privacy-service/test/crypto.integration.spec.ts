import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import {
  BlindIndex,
  CryptoError,
  FieldCipher,
  createKeys,
  mappingBinding,
  vaultBinding,
} from '../src/crypto';

// Seam: the Crypto module together with the real privacy database and the real application role. All values are
// invented. Needs PostgreSQL and scripts/db/bootstrap.ps1 (scripts/db/README.md).
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

const keys = (index = 2) =>
  createKeys({
    token: Buffer.alloc(32, 1),
    index: Buffer.alloc(32, index),
    field: new Map([[1, Buffer.alloc(32, 3)]]),
    fieldVersion: 1,
  });
const cipher = new FieldCipher(keys());
const lookupOf = (subject: string, index = 2): Buffer =>
  new BlindIndex(keys(index)).lookup('CUSTOMER', subject);

const SUBJECT_A = 'CUST-TEST-AAA001';
const SUBJECT_B = 'CUST-TEST-BBB002';
const NIK = 'FAKE-NIK-0000-0001';
const NAMA = 'Nama Fiktif Uji';

/** The reason of the CryptoError thrown by `fn`; any other outcome is reported as such. */
function failureOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof CryptoError ? error.reason : 'not a CryptoError';
  }
  return 'no error';
}

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm202' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
});
afterEach(async () => {
  await db.close();
});

async function insertMapping(subject: string, pseudonym: string): Promise<string> {
  const id = randomUUID();
  await db.app.query(
    `INSERT INTO pseudonym_mapping
       (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
     VALUES ($1, 'CUSTOMER', $2, $3, $4, 'TRANSACTION', 'PAYMENT_PROCESSING', now() + interval '1 hour')`,
    [id, cipher.encrypt(subject, mappingBinding('CUSTOMER', id)), lookupOf(subject), pseudonym],
  );
  return id;
}

async function readEnc(id: string): Promise<Buffer> {
  const { rows } = await db.app.query<{ subject_id_enc: Buffer }>(
    'SELECT subject_id_enc FROM pseudonym_mapping WHERE id = $1',
    [id],
  );
  return rows[0]?.subject_id_enc ?? Buffer.alloc(0);
}

describe('M2-02 FR-25 the database never holds a plaintext', () => {
  it('M2-02 FR-25 a dump of the mapping and the vault shows no subject, NIK or name', async () => {
    await insertMapping(SUBJECT_A, 'PSEU-0000000A');
    const vaultId = randomUUID();
    await db.app.query(
      'INSERT INTO identity_vault (id, customer_lookup, customer_id_enc, nik_enc, nama_enc) VALUES ($1, $2, $3, $4, $5)',
      [
        vaultId,
        lookupOf(SUBJECT_A),
        cipher.encrypt(SUBJECT_A, vaultBinding('customer_id', vaultId)),
        cipher.encrypt(NIK, vaultBinding('nik', vaultId)),
        cipher.encrypt(NAMA, vaultBinding('nama', vaultId)),
      ],
    );
    const { rows } = await db.owner.query<{ dump: string }>(
      `SELECT row_to_json(m)::text AS dump FROM pseudonym_mapping m
       UNION ALL SELECT row_to_json(v)::text FROM identity_vault v`,
    );
    const everything = rows.map((r) => r.dump).join('\n');
    for (const secret of [SUBJECT_A, NIK, NAMA]) {
      expect(everything).not.toContain(secret);
      // Text columns are hex in a dump; the plain bytes must not be there in hex either.
      expect(everything).not.toContain(Buffer.from(secret).toString('hex'));
    }
  });

  it('M2-02 FR-25 the row is found by its lookup and opens with its own binding', async () => {
    const id = await insertMapping(SUBJECT_A, 'PSEU-0000000A');
    await insertMapping(SUBJECT_B, 'PSEU-0000000B');
    const { rows } = await db.app.query<{ id: string; subject_id_enc: Buffer }>(
      'SELECT id, subject_id_enc FROM pseudonym_mapping WHERE subject_lookup = $1',
      [lookupOf(SUBJECT_A)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(
      cipher.decrypt(rows[0]?.subject_id_enc ?? Buffer.alloc(0), mappingBinding('CUSTOMER', id)),
    ).toBe(SUBJECT_A);
  });
});

describe('M2-02 T-16 a ciphertext moved inside the database is refused', () => {
  it('M2-02 T-16 swapping the ciphertext of two mapping rows (as the schema owner) makes both unreadable', async () => {
    const a = await insertMapping(SUBJECT_A, 'PSEU-0000000A');
    const b = await insertMapping(SUBJECT_B, 'PSEU-0000000B');
    const [encA, encB] = [await readEnc(a), await readEnc(b)];
    await db.owner.query('UPDATE pseudonym_mapping SET subject_id_enc = $2 WHERE id = $1', [
      a,
      encB,
    ]);
    await db.owner.query('UPDATE pseudonym_mapping SET subject_id_enc = $2 WHERE id = $1', [
      b,
      encA,
    ]);
    for (const id of [a, b]) {
      const enc = await readEnc(id);
      expect(failureOf(() => cipher.decrypt(enc, mappingBinding('CUSTOMER', id)))).toBe(
        'integrity',
      );
    }
  });

  it('M2-02 T-16 swapping two columns of one vault row makes both unreadable', async () => {
    const id = randomUUID();
    await db.app.query('INSERT INTO identity_vault (id, nik_enc, nama_enc) VALUES ($1, $2, $3)', [
      id,
      cipher.encrypt(NIK, vaultBinding('nik', id)),
      cipher.encrypt(NAMA, vaultBinding('nama', id)),
    ]);
    await db.owner.query(
      'UPDATE identity_vault SET nik_enc = nama_enc, nama_enc = nik_enc WHERE id = $1',
      [id],
    );
    const { rows } = await db.app.query<{ nik_enc: Buffer; nama_enc: Buffer }>(
      'SELECT nik_enc, nama_enc FROM identity_vault WHERE id = $1',
      [id],
    );
    expect(
      failureOf(() => cipher.decrypt(rows[0]?.nik_enc ?? Buffer.alloc(0), vaultBinding('nik', id))),
    ).toBe('integrity');
    expect(
      failureOf(() =>
        cipher.decrypt(rows[0]?.nama_enc ?? Buffer.alloc(0), vaultBinding('nama', id)),
      ),
    ).toBe('integrity');
  });
});

describe('M2-02 rotating the index key', () => {
  it('M2-02 re-computing subject_lookup with a new K_index leaves the ciphertext readable and the row findable', async () => {
    const id = await insertMapping(SUBJECT_A, 'PSEU-0000000A');
    await db.owner.query('UPDATE pseudonym_mapping SET subject_lookup = $2 WHERE id = $1', [
      id,
      lookupOf(SUBJECT_A, 9),
    ]);
    expect(cipher.decrypt(await readEnc(id), mappingBinding('CUSTOMER', id))).toBe(SUBJECT_A);
    const { rows } = await db.app.query(
      'SELECT id FROM pseudonym_mapping WHERE subject_lookup = $1',
      [lookupOf(SUBJECT_A, 9)],
    );
    expect(rows).toHaveLength(1);
  });
});
