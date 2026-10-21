import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, createKeys, vaultBinding } from '../src/crypto';
import { IdentityVault, type StoreIdentityRequest } from '../src/identity';

// Seam: IdentityVault.store on the real privacy database, as the real runtime roles. Every value is invented and
// obviously false (CLAUDE.md). Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

const keys = createKeys({
  token: Buffer.alloc(32, 1),
  index: Buffer.alloc(32, 2),
  field: new Map([[1, Buffer.alloc(32, 3)]]),
  fieldVersion: 1,
});
const cipher = new FieldCipher(keys);

const PERSON = {
  customerId: 'CUST-000101',
  nik: '9999000011112222',
  nama: "Budi O'Contoh-Palsu Jr.",
  hp: '081200000001',
  rekening: '99990000000001',
} as const;
const OTHER = {
  customerId: 'CUST-000102',
  nik: '9999000011113333',
  nama: 'Siti Contoh Palsu',
  hp: '081200000002',
  rekening: '99990000000002',
} as const;

let db: TestDb;
let vault: IdentityVault;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm208' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  vault = new IdentityVault({
    operation: new AuditedOperation(db.app, new AuditWriter()),
    index: new BlindIndex(keys),
    cipher,
    clock: new FakeClock('2026-10-20T08:00:00.000Z'),
    keyVersion: 1,
  });
});
afterEach(async () => {
  await db.close();
});

const store = (
  overrides: Partial<StoreIdentityRequest> = {},
  person: typeof PERSON | typeof OTHER = PERSON,
) => vault.store({ requestingService: 'API_GATEWAY', ...person, ...overrides });

interface VaultRow {
  id: string;
  customer_id_enc: Buffer;
  nik_enc: Buffer;
  nama_enc: Buffer;
  hp_enc: Buffer;
  rekening_enc: Buffer;
}
const rows = async (): Promise<VaultRow[]> =>
  (await db.owner.query<VaultRow>('SELECT * FROM identity_vault ORDER BY created_at, id')).rows;
const auditRows = async () =>
  (
    await db.owner.query<{ action: string; status: string; reason: string }>(
      'SELECT action, status, reason FROM audit_log ORDER BY created_at, id',
    )
  ).rows;

describe('M2-08 POST /identity vault', () => {
  it('M2-08 FR-25 stores the four attributes encrypted per column and answers created', async () => {
    const result = await store();
    expect(result).toEqual({ created: true, storedAttributes: ['nik', 'nama', 'hp', 'rekening'] });
    const [row] = await rows();
    if (row === undefined) throw new Error('one vault row was stored');
    expect(cipher.decrypt(row.nik_enc, vaultBinding('nik', row.id))).toBe(PERSON.nik);
    expect(cipher.decrypt(row.nama_enc, vaultBinding('nama', row.id))).toBe(PERSON.nama);
    expect(cipher.decrypt(row.hp_enc, vaultBinding('hp', row.id))).toBe(PERSON.hp);
    expect(cipher.decrypt(row.rekening_enc, vaultBinding('rekening', row.id))).toBe(
      PERSON.rekening,
    );
    expect(cipher.decrypt(row.customer_id_enc, vaultBinding('customer_id', row.id))).toBe(
      PERSON.customerId,
    );
  });

  it('M2-08 FR-25 a dump of the vault holds only ciphertext, no identity value', async () => {
    await store();
    const { rows: dumped } = await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM identity_vault',
    );
    const dump = JSON.stringify(
      dumped.map((row) =>
        Object.values(row).map((value) =>
          Buffer.isBuffer(value) ? value.toString('latin1') : value,
        ),
      ),
    );
    for (const value of [PERSON.customerId, PERSON.nik, PERSON.nama, PERSON.hp, PERSON.rekening]) {
      expect(dump).not.toContain(value);
    }
  });

  it('M2-08 K-10 the second call updates the same row with new IVs and answers 200 (created false)', async () => {
    await store();
    const [first] = await rows();
    const again = await store();
    expect(again).toEqual({ created: false, storedAttributes: ['nik', 'nama', 'hp', 'rekening'] });
    const after = await rows();
    expect(after).toHaveLength(1);
    const [second] = after;
    if (first === undefined || second === undefined) throw new Error('rows exist');
    expect(second.id).toBe(first.id);
    expect(second.nik_enc.equals(first.nik_enc)).toBe(false);
    // The blob still opens: the update kept the row id the AAD is bound to.
    expect(cipher.decrypt(second.nik_enc, vaultBinding('nik', second.id))).toBe(PERSON.nik);
  });

  it('M2-08 K-10 the second call replaces changed values', async () => {
    await store();
    await store({ hp: '081299999999' });
    const [row] = await rows();
    if (row === undefined) throw new Error('one vault row');
    expect(cipher.decrypt(row.hp_enc, vaultBinding('hp', row.id))).toBe('081299999999');
  });

  it('M2-08 K-10 N-25 eight parallel first calls for one customer leave one row that opens, and one is created', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store()));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    const [row] = all;
    if (row === undefined) throw new Error('one vault row');
    // Whichever call wrote last, the blobs are bound to the one row id.
    expect(cipher.decrypt(row.nik_enc, vaultBinding('nik', row.id))).toBe(PERSON.nik);
    expect(cipher.decrypt(row.customer_id_enc, vaultBinding('customer_id', row.id))).toBe(
      PERSON.customerId,
    );
    expect(await auditRows()).toHaveLength(8);
  });

  it('M2-08 T-16 a ciphertext moved to another customer or column is refused when read', async () => {
    await store();
    await store({}, OTHER);
    const [one, two] = await rows();
    if (one === undefined || two === undefined) throw new Error('two vault rows');
    expect(() => cipher.decrypt(one.nik_enc, vaultBinding('nik', two.id))).toThrow();
    expect(() => cipher.decrypt(one.nik_enc, vaultBinding('hp', one.id))).toThrow();
  });

  it('M2-08 FR-42 TK-20 a caller other than API_GATEWAY is refused: no row, one DENIED audit row', async () => {
    await expect(store({ requestingService: 'TRANSACTION' })).rejects.toMatchObject({
      reason: 'POLICY_NOT_ALLOWED',
    });
    expect(await rows()).toHaveLength(0);
    expect(await auditRows()).toEqual([
      { action: 'STORE_IDENTITY', status: 'DENIED', reason: 'POLICY_NOT_ALLOWED' },
    ]);
  });

  it('M2-08 K-10 every success writes one STORE_IDENTITY row and no audit row holds a value', async () => {
    await store();
    await store();
    expect(await auditRows()).toEqual([
      { action: 'STORE_IDENTITY', status: 'SUCCESS', reason: 'OK' },
      { action: 'STORE_IDENTITY', status: 'SUCCESS', reason: 'OK' },
    ]);
    const page = JSON.stringify((await db.owner.query('SELECT * FROM audit_log')).rows);
    for (const value of [PERSON.customerId, PERSON.nik, PERSON.nama, PERSON.hp, PERSON.rekening]) {
      expect(page).not.toContain(value);
    }
  });

  it.each([
    ['customer id', { customerId: 'CUST-12' }],
    ['nik', { nik: '12345' }],
    ['nik letters', { nik: '99990000111122AB' }],
    ['hp', { hp: '0712000000' }],
    ['rekening', { rekening: '123' }],
    ['nama empty', { nama: '' }],
    ['nama digits', { nama: 'Budi 2' }],
    ['nama too long', { nama: 'a'.repeat(101) }],
  ])(
    'M2-08 validation: a bad %s is VALIDATION_ERROR before anything is stored or audited',
    async (_name, bad) => {
      const failure: unknown = await store(bad as Partial<StoreIdentityRequest>).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).reason).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(failure)).not.toContain('99990000');
      expect(await rows()).toHaveLength(0);
      expect(await auditRows()).toHaveLength(0);
    },
  );
});
