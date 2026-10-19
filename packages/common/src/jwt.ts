import { sign, verify, type KeyObject } from 'node:crypto';
import type { Clock } from './clock';
import { DomainError } from './errors';

/** Signs with RS256 only: the one algorithm the platform accepts (ADR-0007, NFR-21). */
export function signJwt(
  claims: Readonly<Record<string, unknown>>,
  key: { privateKey: KeyObject; kid: string },
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

export interface VerifyOptions {
  readonly clock: Clock;
  readonly issuer: string;
  /** The receiving service: the token's `aud` must contain it. */
  readonly audience: string;
  /** The public key for a key id, or undefined when the id is not one of the issuer's keys. */
  readonly resolveKey: (kid: string | undefined) => KeyObject | undefined;
}

// A token is a few hundred bytes; a longer string is not one, and is not worth parsing.
const MAX_LENGTH = 8192;
const SEGMENT = /^[A-Za-z0-9_-]*$/;

const reject = (category: string): never => {
  // The category says which check failed, never what the token held: it may reach a log through `cause`.
  throw new DomainError('UNAUTHENTICATED', category);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function decodeObject(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return reject('malformed');
  }
  return isObject(parsed) ? parsed : reject('malformed');
}

/**
 * Checks a token the way every receiving service must: RS256 only (so `none` and HS256, including the public key used
 * as an HMAC secret, never get through), a key id the issuer published, the signature, `iss`, `aud`, `exp`, and
 * `nbf`/`iat` when present. There is no leeway: the clock is the injected one (NFR-20). Throws UNAUTHENTICATED with a
 * short category as `cause`; returns the claims.
 */
export function verifyJwt(token: string, options: VerifyOptions): Record<string, unknown> {
  if (token.length === 0 || token.length > MAX_LENGTH) return reject('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return reject('malformed');
  const [headerSegment = '', payloadSegment = '', signatureSegment = ''] = parts;

  const header = decodeObject(headerSegment);
  if (header['alg'] !== 'RS256' || 'crit' in header) return reject('alg');
  const kid = header['kid'];
  const key = typeof kid === 'string' ? options.resolveKey(kid) : undefined;
  if (key === undefined) return reject('kid');

  const payload = decodeObject(payloadSegment);
  const signature = Buffer.from(signatureSegment, 'base64url');
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`);
  if (signature.length === 0 || !verify('RSA-SHA256', signed, key, signature))
    return reject('signature');

  if (payload['iss'] !== options.issuer) return reject('issuer');
  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isInteger(exp)) return reject('claims');
  const now = Math.floor(options.clock.now().getTime() / 1000);
  for (const claim of ['nbf', 'iat'] as const) {
    const value = payload[claim];
    if (value !== undefined && (typeof value !== 'number' || value > now))
      return reject('not_yet_valid');
  }
  if (exp <= now) return reject('expired');
  const audience = payload['aud'];
  const audiences =
    typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
  if (!audiences.includes(options.audience)) return reject('audience');
  return payload;
}
