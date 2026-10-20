import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoError } from './errors';
import { keyMaterial, type PrivacyKeys } from './keys';
import type { RowBinding } from './parts';

const VERSION_BYTES = 2;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for the encrypted columns (PRD 6.2, ADR-0011). Blob: key_version(uint16 BE) || IV(12, random for each
 * write) || ciphertext || tag(16). The AAD is the row binding, so a blob opens only in the row, kind and column it
 * was written for (T-16). Only `node:crypto` is used (S-32).
 */
export class FieldCipher {
  constructor(private readonly keys: PrivacyKeys) {}

  encrypt(plaintext: string, binding: RowBinding): Buffer {
    const { field, fieldVersion } = keyMaterial(this.keys);
    const key = field.get(fieldVersion);
    if (key === undefined) throw new CryptoError('bad_key', 'the current key version has no key');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(binding);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const version = Buffer.alloc(VERSION_BYTES);
    version.writeUInt16BE(fieldVersion);
    return Buffer.concat([version, iv, body, cipher.getAuthTag()]);
  }

  decrypt(blob: Buffer, binding: RowBinding): string {
    if (!Buffer.isBuffer(blob) || blob.length < VERSION_BYTES + IV_BYTES + TAG_BYTES) {
      throw new CryptoError('malformed', 'the blob is too short');
    }
    const key = keyMaterial(this.keys).field.get(blob.readUInt16BE(0));
    // The version in the blob picks the key; an unknown one is never tried against another key.
    if (key === undefined) throw new CryptoError('unknown_key_version', 'no key for this version');
    const iv = blob.subarray(VERSION_BYTES, VERSION_BYTES + IV_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const body = blob.subarray(VERSION_BYTES + IV_BYTES, blob.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(binding);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, wrong row, or a changed byte all look the same on purpose; the node error text is dropped.
      throw new CryptoError('integrity', 'the blob does not authenticate for this row');
    }
  }
}
