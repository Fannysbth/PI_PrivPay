import { timingSafeEqual } from 'node:crypto';

const asBytes = (value: unknown): Buffer | undefined => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return undefined;
};

/**
 * The only way to compare a secret (a key, a client secret) with another value: `===` stops at the first differing
 * byte and so leaks how much of a guess was right. `timingSafeEqual` refuses buffers of different lengths, so those
 * are false here; the length of a secret is not treated as secret. Anything that is not a string or a Buffer never
 * matches, so an unvalidated request field cannot raise an error that tells it apart from a wrong secret.
 */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = asBytes(a);
  const right = asBytes(b);
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
