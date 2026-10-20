import { inspect } from 'node:util';
import { ConfigError, readKey, safeEqual, type EnvSource } from '@privpay/common';
import { CryptoError } from './errors';

const KEY_BYTES = 32;
const MAX_KEY_VERSION = 0xffff;

export interface KeyMaterial {
  /** K_token: pseudonym values. */
  readonly token: Buffer;
  /** K_index: subject_lookup (blind index). */
  readonly index: Buffer;
  /** K_field by key_version; decryption picks the key from the blob's version. */
  readonly field: ReadonlyMap<number, Buffer>;
  /** The version new blobs are written with. */
  readonly fieldVersion: number;
}

// The material lives in a WeakMap, not in fields, so JSON.stringify, inspect and a logger cannot reach a key from
// a PrivacyKeys object (NFR-07). Only the sibling modules of ./crypto read it, through `keyMaterial`.
const material = new WeakMap<PrivacyKeys, KeyMaterial>();

/** The three separate keys of the Privacy Service (FR-30). Opaque: it prints as `[PrivacyKeys]`. */
export class PrivacyKeys {
  constructor(value: KeyMaterial) {
    material.set(this, value);
  }
  toJSON(): string {
    return '[PrivacyKeys]';
  }
  toString(): string {
    return '[PrivacyKeys]';
  }
  [inspect.custom](): string {
    return '[PrivacyKeys]';
  }
}

/** For the other modules of the Crypto package only; it is not exported from `index.ts`. */
export function keyMaterial(keys: PrivacyKeys): KeyMaterial {
  const found = material.get(keys);
  if (found === undefined) throw new CryptoError('bad_key', 'not a PrivacyKeys');
  return found;
}

/**
 * Checks the keys of FR-30: each exactly 32 bytes, and K_token, K_index and every K_field different from each other.
 * Messages say which rule failed and never show a key.
 */
export function createKeys(value: KeyMaterial): PrivacyKeys {
  const named: [string, Buffer][] = [
    ['K_token', value.token],
    ['K_index', value.index],
    ...[...value.field].map(([version, key]): [string, Buffer] => [
      `K_field v${String(version)}`,
      key,
    ]),
  ];
  for (const [name, key] of named) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw new CryptoError('bad_key', `${name} is not ${String(KEY_BYTES)} bytes`);
    }
  }
  for (const version of value.field.keys()) {
    if (!Number.isInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
      throw new CryptoError('bad_key', 'a key version is outside 1..65535');
    }
  }
  if (!value.field.has(value.fieldVersion)) {
    throw new CryptoError('bad_key', 'the current key version has no key');
  }
  // Every pair differs (FR-30, S-03): the three kinds from each other, and every field version from all the others,
  // so a rotation to an identical key is refused. The comparison is the constant-time one used for every secret.
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (safeEqual(named[i]?.[1] ?? '', named[j]?.[1] ?? '')) {
        throw new CryptoError('bad_key', `${named[i]?.[0] ?? ''} equals ${named[j]?.[0] ?? ''}`);
      }
    }
  }
  return new PrivacyKeys({
    token: Buffer.from(value.token),
    index: Buffer.from(value.index),
    field: new Map([...value.field].map(([version, key]) => [version, Buffer.from(key)])),
    fieldVersion: value.fieldVersion,
  });
}

/**
 * Reads the three keys from the files named by `PSEUDONYM_HMAC_SECRET_FILE`, `BLIND_INDEX_SECRET_FILE` and
 * `FIELD_ENCRYPTION_KEY_FILE` (hex, 32 bytes). A raw key in the environment is refused. The service does not start
 * when this throws (spec privacy 3).
 */
export function loadKeys(env: EnvSource): PrivacyKeys {
  const fieldVersion = parseKeyVersion(env['PSEUDONYM_KEY_VERSION']);
  return createKeys({
    token: readKey(env, 'PSEUDONYM_HMAC_SECRET', KEY_BYTES),
    index: readKey(env, 'BLIND_INDEX_SECRET', KEY_BYTES),
    field: new Map([[fieldVersion, readKey(env, 'FIELD_ENCRYPTION_KEY', KEY_BYTES)]]),
    fieldVersion,
  });
}

function parseKeyVersion(raw: string | undefined): number {
  const version = raw === undefined ? NaN : Number(raw);
  if (!/^[0-9]+$/.test(raw ?? '') || version < 1 || version > MAX_KEY_VERSION) {
    throw new ConfigError([{ name: 'PSEUDONYM_KEY_VERSION', problem: 'invalid' }]);
  }
  return version;
}
