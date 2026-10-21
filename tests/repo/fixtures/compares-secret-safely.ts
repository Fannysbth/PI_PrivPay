import { timingSafeEqual } from 'node:crypto';

// Allowed: constant-time comparison, a length check, and presence checks that compare with no secret value.
export const same = (clientSecret: Buffer, expected: Buffer): boolean =>
  clientSecret.length === expected.length && timingSafeEqual(clientSecret, expected);

export const present = (secret: string | undefined): boolean =>
  secret !== undefined && secret !== '';

export const absent = (secret: string | undefined): boolean => secret === void 0;
