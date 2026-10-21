import nodeCrypto from 'node:crypto';
import { safeEqual } from '../src/safe-equal';

// Fake secrets only; nothing here is a real credential.
const secret = 'fake-client-secret-0001';

describe('M1-01 safeEqual compares secrets in constant time (platform spec 7 item 7)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('M1-01 equal strings and equal buffers match', () => {
    expect(safeEqual(secret, 'fake-client-secret-0001')).toBe(true);
    expect(safeEqual(Buffer.from(secret), Buffer.from(secret))).toBe(true);
    expect(safeEqual(secret, Buffer.from(secret))).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('M1-01 a different value of the same length does not match', () => {
    expect(safeEqual(secret, 'fake-client-secret-0002')).toBe(false);
    expect(safeEqual(secret, secret.toUpperCase())).toBe(false);
  });

  it('M1-01 a value of another length is false, not an exception', () => {
    // timingSafeEqual itself throws on a length mismatch; the wrapper must turn that into false.
    expect(() => safeEqual(secret, secret + 'x')).not.toThrow();
    expect(safeEqual(secret, secret + 'x')).toBe(false);
    expect(safeEqual(secret, '')).toBe(false);
  });

  it('M1-01 compares multi-byte text by its bytes, so characters that differ in length cannot collide', () => {
    expect(safeEqual('é', 'é')).toBe(true);
    expect(safeEqual('é', 'e')).toBe(false);
  });

  it('M1-01 anything that is not a string or a buffer never matches', () => {
    const unknown: unknown[] = [undefined, null, 1, {}, ['fake-client-secret-0001']];
    for (const value of unknown) {
      expect(safeEqual(secret, value as string)).toBe(false);
      expect(safeEqual(value as string, secret)).toBe(false);
    }
  });

  it('M1-01 equal-length values are compared with crypto.timingSafeEqual, not with ===', () => {
    const spy = jest.spyOn(nodeCrypto, 'timingSafeEqual');
    expect(safeEqual(secret, 'fake-client-secret-0002')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
