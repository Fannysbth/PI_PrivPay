import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  BlindIndex,
  CryptoError,
  FieldCipher,
  TokenMint,
  createKeys,
  encodeParts,
  loadKeys,
  mappingBinding,
  vaultBinding,
  type PrivacyKeys,
  type RowBinding,
} from '../src/crypto';
import * as cryptoModule from '../src/crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Seam: the public interface of the Crypto module (loadKeys, FieldCipher, BlindIndex, TokenMint and the row
// bindings). Pure unit tests; every key and value below is invented.
const hex = (fill: number): string => Buffer.alloc(32, fill).toString('hex');
const keys = (overrides: Partial<Parameters<typeof createKeys>[0]> = {}): PrivacyKeys =>
  createKeys({
    token: Buffer.alloc(32, 1),
    index: Buffer.alloc(32, 2),
    field: new Map([[1, Buffer.alloc(32, 3)]]),
    fieldVersion: 1,
    ...overrides,
  });

const ROW_A = '11111111-1111-4111-8111-111111111111';
const ROW_B = '22222222-2222-4222-8222-222222222222';
const PLAIN = 'FAKE-CUSTOMER-000101';

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoError) return error.reason;
    throw error;
  }
  return 'no error';
};

describe('M2-02 S-31 NFR-05 the encrypted field format', () => {
  const cipher = new FieldCipher(keys());
  const binding = mappingBinding('CUSTOMER', ROW_A);

  it('M2-02 S-31 NFR-05 the blob is key_version(uint16) || IV(12) || ciphertext || tag(16) and round-trips', () => {
    const blob = cipher.encrypt(PLAIN, binding);
    expect(blob.readUInt16BE(0)).toBe(1);
    expect(blob.length).toBe(2 + 12 + Buffer.byteLength(PLAIN) + 16);
    expect(cipher.decrypt(blob, binding)).toBe(PLAIN);
  });

  it('M2-02 S-31 the same value encrypted many times never repeats an IV or a blob', () => {
    const blobs = Array.from({ length: 500 }, () => cipher.encrypt(PLAIN, binding));
    expect(new Set(blobs.map((b) => b.subarray(2, 14).toString('hex'))).size).toBe(500);
    expect(new Set(blobs.map((b) => b.toString('hex'))).size).toBe(500);
  });

  it('M2-02 S-31 the plaintext does not appear in the blob', () => {
    const blob = cipher.encrypt(PLAIN, binding);
    expect(blob.includes(Buffer.from(PLAIN))).toBe(false);
  });

  it('M2-02 S-31 NFR-05 a changed bit in the version, the IV, the ciphertext or the tag is refused', () => {
    const blob = cipher.encrypt(PLAIN, binding);
    for (let position = 0; position < blob.length; position += 1) {
      for (const bit of [0x01, 0x80]) {
        const tampered = Buffer.from(blob);
        tampered[position] = (tampered[position] ?? 0) ^ bit;
        // The two version bytes name a key that does not exist; every other byte must fail authentication.
        expect(reasonOf(() => cipher.decrypt(tampered, binding))).toBe(
          position < 2 ? 'unknown_key_version' : 'integrity',
        );
      }
    }
  });

  it('M2-02 S-31 a truncated, extended or empty blob is refused', () => {
    const blob = cipher.encrypt(PLAIN, binding);
    for (const bad of [
      blob.subarray(0, blob.length - 1),
      Buffer.concat([blob, Buffer.from([0])]),
      Buffer.alloc(0),
      blob.subarray(0, 2 + 12 + 15),
    ]) {
      expect(reasonOf(() => cipher.decrypt(bad, binding))).not.toBe('no error');
    }
  });

  it('M2-02 S-31 a version with no key is refused as unknown_key_version, not tried with another key', () => {
    const blob = cipher.encrypt(PLAIN, binding);
    blob.writeUInt16BE(7, 0);
    expect(reasonOf(() => cipher.decrypt(blob, binding))).toBe('unknown_key_version');
  });

  it('M2-02 S-31 an old blob still opens after the current key version moves on; new blobs use the new one', () => {
    const k1 = Buffer.alloc(32, 3);
    const k2 = Buffer.alloc(32, 4);
    const before = new FieldCipher(keys({ field: new Map([[1, k1]]), fieldVersion: 1 }));
    const old = before.encrypt(PLAIN, binding);
    const after = new FieldCipher(
      keys({
        field: new Map([
          [1, k1],
          [2, k2],
        ]),
        fieldVersion: 2,
      }),
    );
    expect(after.decrypt(old, binding)).toBe(PLAIN);
    expect(after.encrypt(PLAIN, binding).readUInt16BE(0)).toBe(2);
  });

  it('M2-02 S-31 the error says why in a fixed word and never carries the value', () => {
    const blob = cipher.encrypt(PLAIN, binding);
    blob[20] = (blob[20] ?? 0) ^ 1;
    try {
      cipher.decrypt(blob, binding);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as Error).message).not.toContain(PLAIN);
      expect((error as Error).message).not.toContain(blob.toString('hex'));
    }
  });
});

describe('M2-02 T-16 a ciphertext is bound to its row, its kind and its column', () => {
  const cipher = new FieldCipher(keys());

  it('M2-02 T-16 a mapping ciphertext does not open in another row', () => {
    const blob = cipher.encrypt(PLAIN, mappingBinding('CUSTOMER', ROW_A));
    expect(reasonOf(() => cipher.decrypt(blob, mappingBinding('CUSTOMER', ROW_B)))).toBe(
      'integrity',
    );
  });

  it('M2-02 T-16 a mapping ciphertext does not open under the other subject type', () => {
    const blob = cipher.encrypt(PLAIN, mappingBinding('CUSTOMER', ROW_A));
    expect(reasonOf(() => cipher.decrypt(blob, mappingBinding('ACCOUNT', ROW_A)))).toBe(
      'integrity',
    );
  });

  it('M2-02 T-16 a vault ciphertext does not open in another row or in another column', () => {
    const blob = cipher.encrypt(PLAIN, vaultBinding('nik', ROW_A));
    expect(cipher.decrypt(blob, vaultBinding('nik', ROW_A))).toBe(PLAIN);
    expect(reasonOf(() => cipher.decrypt(blob, vaultBinding('nik', ROW_B)))).toBe('integrity');
    expect(reasonOf(() => cipher.decrypt(blob, vaultBinding('nama', ROW_A)))).toBe('integrity');
  });

  it('M2-02 T-16 a vault ciphertext does not open as a mapping and the other way round', () => {
    const vault = cipher.encrypt(PLAIN, vaultBinding('customer_id', ROW_A));
    const mapping = cipher.encrypt(PLAIN, mappingBinding('CUSTOMER', ROW_A));
    expect(reasonOf(() => cipher.decrypt(vault, mappingBinding('CUSTOMER', ROW_A)))).toBe(
      'integrity',
    );
    expect(reasonOf(() => cipher.decrypt(mapping, vaultBinding('customer_id', ROW_A)))).toBe(
      'integrity',
    );
  });

  it('M2-02 T-16 the bindings are exactly the AAD of ADR-0011: mapping+type+id, vault+column+id', () => {
    // Expected bytes written out from the ADR: 4-byte length, then the part.
    const part = (text: string): number[] => [0, 0, 0, text.length, ...Buffer.from(text)];
    expect([...mappingBinding('CUSTOMER', ROW_A)]).toEqual([
      ...part('mapping'),
      ...part('CUSTOMER'),
      ...part(ROW_A),
    ]);
    expect([...vaultBinding('nik', ROW_A)]).toEqual([
      ...part('vault'),
      ...part('nik'),
      ...part(ROW_A),
    ]);
  });

  it('M2-02 T-16 guard: an AAD that is empty or made by hand is refused, so it cannot be dropped', () => {
    const blob = cipher.encrypt(PLAIN, mappingBinding('CUSTOMER', ROW_A));
    const empty = Buffer.alloc(0) as RowBinding;
    // Same bytes as the real binding, but not issued by mappingBinding.
    const handMade = encodeParts('mapping', 'CUSTOMER', ROW_A) as RowBinding;
    for (const forged of [empty, handMade]) {
      expect(reasonOf(() => cipher.encrypt(PLAIN, forged))).toBe('malformed');
      expect(reasonOf(() => cipher.decrypt(blob, forged))).toBe('malformed');
    }
  });

  it('M2-02 T-16 the row id must be a UUID v4: a v1 or v7 id is refused too', () => {
    expect(reasonOf(() => mappingBinding('CUSTOMER', '11111111-1111-1111-8111-111111111111'))).toBe(
      'malformed',
    );
    expect(reasonOf(() => vaultBinding('nik', '01890a5d-ac96-774b-bcce-b302099a8057'))).toBe(
      'malformed',
    );
  });

  it('M2-02 T-16 the row id must be a UUID: a free text id is refused before anything is encrypted', () => {
    expect(reasonOf(() => mappingBinding('CUSTOMER', 'not-a-uuid'))).toBe('malformed');
    expect(reasonOf(() => vaultBinding('nik', ''))).toBe('malformed');
  });

  it('M2-02 T-16 only the five vault columns have a binding', () => {
    for (const column of ['customer_id', 'nik', 'nama', 'hp', 'rekening']) {
      expect(reasonOf(() => vaultBinding(column, ROW_A))).toBe('no error');
    }
    expect(reasonOf(() => vaultBinding('email', ROW_A))).toBe('malformed');
  });
});

describe('M2-02 the "||" encoding is unambiguous', () => {
  it('M2-02 ("CUST-1","2") and ("CUST-12","") encode differently (ADR-0011 butir 2)', () => {
    expect(encodeParts('CUST-1', '2').equals(encodeParts('CUST-12', ''))).toBe(false);
    expect(encodeParts('a', 'bc').equals(encodeParts('ab', 'c'))).toBe(false);
  });

  it('M2-02 each part has a 4-byte big-endian length in front', () => {
    expect([...encodeParts('ab', 'c')]).toEqual([0, 0, 0, 2, 97, 98, 0, 0, 0, 1, 99]);
  });
});

describe('M2-02 known answers computed outside this code base', () => {
  // Made with Python hmac/hashlib from the formulas of spec privacy 5: HMAC-SHA256 over the 4-byte-length-prefixed
  // parts. A change in the order or the encoding of the parts fails these, whatever the unit tests above do.
  it('M2-02 subject_lookup of (CUSTOMER, CUST-000101) under K_index=0x02*32', () => {
    expect(new BlindIndex(keys()).lookup('CUSTOMER', 'CUST-000101').toString('hex')).toBe(
      '51054eaeb30542572ae77a59fa90776ac2c4852f4440cd2a655308e436325cb5',
    );
  });

  it('M2-02 the pseudonym of (CUSTOMER, CUST-000101, TRANSACTION, PAYMENT_PROCESSING, nonce) under K_token=0x01*32', () => {
    expect(
      new TokenMint(keys()).mint({
        subjectType: 'CUSTOMER',
        subjectId: 'CUST-000101',
        serviceId: 'TRANSACTION',
        purpose: 'PAYMENT_PROCESSING',
        nonce: '33333333-3333-4333-8333-333333333333',
      }),
    ).toBe('PSEU-8D77B8FD');
  });
});

describe('M2-02 the blind index', () => {
  const index = new BlindIndex(keys());

  it('M2-02 is a deterministic 32-byte value for the same subject', () => {
    const first = index.lookup('CUSTOMER', 'CUST-000101');
    expect(first).toHaveLength(32);
    expect(index.lookup('CUSTOMER', 'CUST-000101').equals(first)).toBe(true);
  });

  it('M2-02 differs by subject type, by subject and by key', () => {
    const base = index.lookup('CUSTOMER', 'CUST-000101');
    expect(index.lookup('ACCOUNT', 'CUST-000101').equals(base)).toBe(false);
    expect(index.lookup('CUSTOMER', 'CUST-000102').equals(base)).toBe(false);
    const other = new BlindIndex(keys({ index: Buffer.alloc(32, 9) }));
    expect(other.lookup('CUSTOMER', 'CUST-000101').equals(base)).toBe(false);
  });

  it('M2-02 FR-30 does not depend on the token key or the field key', () => {
    const base = index.lookup('CUSTOMER', 'CUST-000101');
    const others = new BlindIndex(
      keys({ token: Buffer.alloc(32, 8), field: new Map([[1, Buffer.alloc(32, 9)]]) }),
    );
    expect(others.lookup('CUSTOMER', 'CUST-000101').equals(base)).toBe(true);
  });

  it('M2-02 a new index key (rotation) does not break decryption of an existing blob', () => {
    const cipher = new FieldCipher(keys());
    const binding = mappingBinding('CUSTOMER', ROW_A);
    const blob = cipher.encrypt(PLAIN, binding);
    const rotated = keys({ index: Buffer.alloc(32, 9) });
    expect(new FieldCipher(rotated).decrypt(blob, binding)).toBe(PLAIN);
  });
});

describe('M2-02 the token value', () => {
  const mint = new TokenMint(keys());
  const input = {
    subjectType: 'CUSTOMER',
    subjectId: 'CUST-000101',
    serviceId: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    nonce: '33333333-3333-4333-8333-333333333333',
  } as const;

  it('M2-02 has the form PSEU- and eight upper-case hex digits (13 characters)', () => {
    expect(mint.mint(input)).toMatch(/^PSEU-[0-9A-F]{8}$/);
  });

  it('M2-02 is repeatable for the same input and changes with the nonce', () => {
    expect(mint.mint(input)).toBe(mint.mint(input));
    expect(mint.mint({ ...input, nonce: '44444444-4444-4444-8444-444444444444' })).not.toBe(
      mint.mint(input),
    );
  });

  it('M2-02 differs by service, purpose and key; the index key does not matter', () => {
    const base = mint.mint(input);
    expect(mint.mint({ ...input, serviceId: 'FRAUD' })).not.toBe(base);
    expect(mint.mint({ ...input, purpose: 'FRAUD_DETECTION' })).not.toBe(base);
    expect(new TokenMint(keys({ token: Buffer.alloc(32, 9) })).mint(input)).not.toBe(base);
    expect(new TokenMint(keys({ index: Buffer.alloc(32, 9) })).mint(input)).toBe(base);
  });

  it('M2-02 does not reveal the subject: the value contains nothing of the identifier', () => {
    expect(mint.mint(input)).not.toContain('000101');
  });

  it('M2-02 a nonce that is not a UUID v4 is refused (a v1 or v7 UUID too)', () => {
    for (const nonce of [
      '11111111-1111-1111-8111-111111111111',
      '01890a5d-ac96-774b-bcce-b302099a8057',
      '33333333-3333-4333-c333-333333333333',
    ]) {
      expect(reasonOf(() => mint.mint({ ...input, nonce }))).toBe('malformed');
    }
  });

  it('M2-02 a nonce that is not a UUID is refused', () => {
    expect(reasonOf(() => mint.mint({ ...input, nonce: 'abc' }))).toBe('malformed');
  });
});

describe('M2-02 FR-30 S-03 the three keys', () => {
  it('M2-02 FR-30 accepts three different keys of 32 bytes', () => {
    expect(reasonOf(() => keys())).toBe('no error');
  });

  it.each([
    ['token', { token: Buffer.alloc(31, 1) }],
    ['index', { index: Buffer.alloc(33, 2) }],
    ['field', { field: new Map([[1, Buffer.alloc(16, 3)]]) }],
    ['token empty', { token: Buffer.alloc(0) }],
  ])('M2-02 FR-30 refuses a %s key that is not 32 bytes', (_name, override) => {
    expect(reasonOf(() => keys(override))).toBe('bad_key');
  });

  it.each([
    ['token = index', { index: Buffer.alloc(32, 1) }],
    ['token = field', { field: new Map([[1, Buffer.alloc(32, 1)]]) }],
    ['index = field', { field: new Map([[1, Buffer.alloc(32, 2)]]) }],
  ])('M2-02 FR-30 refuses keys that are equal: %s', (_name, override) => {
    expect(reasonOf(() => keys(override))).toBe('bad_key');
  });

  it('M2-02 FR-30 refuses an old field key equal to the token or the index key too', () => {
    expect(
      reasonOf(() =>
        keys({
          field: new Map([
            [1, Buffer.alloc(32, 1)],
            [2, Buffer.alloc(32, 3)],
          ]),
          fieldVersion: 2,
        }),
      ),
    ).toBe('bad_key');
  });

  it('M2-02 FR-30 refuses two field versions that hold the same key (a rotation to nothing)', () => {
    expect(
      reasonOf(() =>
        keys({
          field: new Map([
            [1, Buffer.alloc(32, 3)],
            [2, Buffer.alloc(32, 3)],
          ]),
          fieldVersion: 2,
        }),
      ),
    ).toBe('bad_key');
  });

  it('M2-02 FR-30 the PrivacyKeys class is not exported: keys can only come from createKeys or loadKeys', () => {
    expect(Object.keys(cryptoModule)).not.toContain('PrivacyKeys');
  });

  it('M2-02 FR-30 a key buffer changed by the caller afterwards does not change the keys', () => {
    const source = Buffer.alloc(32, 3);
    const material = keys({ field: new Map([[1, source]]) });
    const binding = mappingBinding('CUSTOMER', ROW_A);
    const blob = new FieldCipher(material).encrypt(PLAIN, binding);
    source.fill(9);
    expect(new FieldCipher(material).decrypt(blob, binding)).toBe(PLAIN);
  });

  it('M2-02 FR-30 refuses a current version that has no key, and a version outside uint16', () => {
    expect(reasonOf(() => keys({ fieldVersion: 2 }))).toBe('bad_key');
    expect(
      reasonOf(() => keys({ field: new Map([[70000, Buffer.alloc(32, 3)]]), fieldVersion: 70000 })),
    ).toBe('bad_key');
  });

  it('M2-02 NFR-07 the keys never show in JSON, in inspect or in a string', () => {
    const material = keys();
    const shown = [JSON.stringify(material), inspect(material, { depth: 5 }), String(material)];
    for (const text of shown) {
      for (const fill of [1, 2, 3]) {
        expect(text).not.toContain(hex(fill));
        expect(text).not.toContain(Buffer.alloc(32, fill).toString('base64'));
      }
    }
  });
});

describe('M2-02 FR-30 the keys are read from files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'privpay-keys-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  const env = (overrides: Record<string, string> = {}): Record<string, string> => ({
    PSEUDONYM_HMAC_SECRET_FILE: put('token', hex(1)),
    BLIND_INDEX_SECRET_FILE: put('index', hex(2)),
    FIELD_ENCRYPTION_KEY_FILE: put('field', `${hex(3)}\n`),
    PSEUDONYM_KEY_VERSION: '1',
    ...overrides,
  });

  it('M2-02 FR-30 loads three hex files into working keys', () => {
    const material = loadKeys(env());
    const cipher = new FieldCipher(material);
    const binding = mappingBinding('CUSTOMER', ROW_A);
    expect(cipher.decrypt(cipher.encrypt(PLAIN, binding), binding)).toBe(PLAIN);
  });

  it('M2-02 FR-30 start fails when a file is missing, empty, not hex, or the wrong length', () => {
    expect(() => loadKeys(env({ BLIND_INDEX_SECRET_FILE: join(dir, 'absent') }))).toThrow(
      /BLIND_INDEX_SECRET_FILE/,
    );
    expect(() => loadKeys(env({ BLIND_INDEX_SECRET_FILE: put('e', '') }))).toThrow(/empty/);
    expect(() => loadKeys(env({ BLIND_INDEX_SECRET_FILE: put('n', 'zz'.repeat(32)) }))).toThrow(
      /invalid/,
    );
    expect(() => loadKeys(env({ BLIND_INDEX_SECRET_FILE: put('s', hex(2).slice(2)) }))).toThrow(
      /invalid/,
    );
  });

  it('M2-02 FR-30 start fails when two files hold the same key, and the message holds no key', () => {
    const same = env({ BLIND_INDEX_SECRET_FILE: put('same', hex(1)) });
    try {
      loadKeys(same);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as Error).message).not.toContain(hex(1));
    }
  });

  it('M2-02 FR-30 a raw key in the environment is refused (secrets come from files only)', () => {
    expect(() => loadKeys({ ...env(), FIELD_ENCRYPTION_KEY: hex(3) })).toThrow(/raw_secret/);
  });

  it('M2-02 FR-30 PSEUDONYM_KEY_VERSION must be a whole number from 1 to 65535', () => {
    for (const bad of ['0', '-1', '1.5', 'x', '65536']) {
      expect(() => loadKeys(env({ PSEUDONYM_KEY_VERSION: bad }))).toThrow();
    }
  });
});

describe('M2-02 S-32 no crypto of our own and no crypto library', () => {
  const sources = join(__dirname, '..', 'src', 'crypto');
  const allowed = /^(node:crypto|node:util|@privpay\/common|\.\/[a-z-]+)$/;

  it('M2-02 S-32 the module imports only node:crypto, node:util, the common package and itself', () => {
    const files = readdirSync(sources).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(sources, file), 'utf8');
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const specifier of specifiers)
        expect([file, specifier]).toEqual([file, expect.stringMatching(allowed)]);
    }
  });

  it('M2-02 S-32 the only primitives used are AES-256-GCM and HMAC-SHA256', () => {
    const text = readdirSync(sources)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(sources, f), 'utf8'))
      .join('\n');
    const algorithms = [
      ...text.matchAll(/(?:createCipheriv|createDecipheriv|createHmac|createHash)\(\s*'([^']+)'/g),
    ].map((m) => m[1]);
    expect(new Set(algorithms)).toEqual(new Set(['aes-256-gcm', 'sha256']));
  });
});
