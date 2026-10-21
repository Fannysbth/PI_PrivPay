import { createHmac, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { FakeClock } from '../src/clock';
import { DomainError } from '../src/errors';
import { signJwt, verifyJwt, type VerifyOptions } from '../src/jwt';

// Keys made for the test run; nothing is read from or written to disk.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const START = new Date('2026-10-19T08:00:00Z');
const NOW = Math.floor(START.getTime() / 1000);

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: 'privpay-dev-idp',
  sub: 'usr-test',
  aud: ['transaction-service'],
  iat: NOW,
  exp: NOW + 300,
  ...extra,
});
const options = (clock: FakeClock, override: Partial<VerifyOptions> = {}): VerifyOptions => ({
  clock,
  issuer: 'privpay-dev-idp',
  audience: 'transaction-service',
  resolveKey: (kid: string | undefined): KeyObject | undefined =>
    kid === KID ? pair.publicKey : undefined,
  ...override,
});
const sign = (payload: Record<string, unknown>): string =>
  signJwt(payload, { privateKey: pair.privateKey, kid: KID });
/** The category carried by the DomainError (the `cause` of UNAUTHENTICATED), or the error name. */
const failure = (token: string, opts: VerifyOptions): string => {
  try {
    verifyJwt(token, opts);
  } catch (error) {
    if (error instanceof DomainError && error.reason === 'UNAUTHENTICATED') {
      return String(error.cause);
    }
    throw error;
  }
  return 'accepted';
};

describe('M1-01 signJwt and verifyJwt: RS256 only, every claim checked (NFR-21, ADR-0007)', () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = new FakeClock(START);
  });

  it('M1-01 a signed token verifies and returns its claims', () => {
    const verified = verifyJwt(sign(claims()), options(clock));
    expect(verified).toMatchObject({ iss: 'privpay-dev-idp', sub: 'usr-test', exp: NOW + 300 });
  });

  it('M1-01 the header names RS256, the key id and nothing that selects another algorithm', () => {
    const [header] = sign(claims()).split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: KID,
    });
  });

  it('M1-01 audience may be a string or a list, and must contain the receiving service', () => {
    expect(failure(sign(claims({ aud: 'transaction-service' })), options(clock))).toBe('accepted');
    expect(
      failure(sign(claims({ aud: ['fraud-service', 'transaction-service'] })), options(clock)),
    ).toBe('accepted');
    expect(failure(sign(claims({ aud: ['fraud-service'] })), options(clock))).toBe('audience');
    expect(failure(sign(claims({ aud: undefined })), options(clock))).toBe('audience');
    expect(failure(sign(claims({ aud: 42 })), options(clock))).toBe('audience');
  });

  it('M1-01 an expired token is rejected, with no leeway', () => {
    const token = sign(claims());
    clock.advance(299);
    expect(failure(token, options(clock))).toBe('accepted');
    clock.advance(1);
    expect(failure(token, options(clock))).toBe('expired');
  });

  it('M1-01 a token without a numeric exp is rejected', () => {
    expect(failure(sign(claims({ exp: undefined })), options(clock))).toBe('claims');
    expect(failure(sign(claims({ exp: '9999999999' })), options(clock))).toBe('claims');
    expect(failure(sign(claims({ exp: 1.5 })), options(clock))).toBe('claims');
  });

  it('M1-01 a token that is not valid yet (nbf) is rejected', () => {
    expect(failure(sign(claims({ nbf: NOW + 60 })), options(clock))).toBe('not_yet_valid');
  });

  it('M1-01 another issuer is rejected', () => {
    expect(failure(sign(claims({ iss: 'someone-else' })), options(clock))).toBe('issuer');
    expect(failure(sign(claims({ iss: undefined })), options(clock))).toBe('issuer');
  });

  it('M1-01 a token signed by another key, or with a changed payload, fails the signature', () => {
    const forged = signJwt(claims(), { privateKey: other.privateKey, kid: KID });
    expect(failure(forged, options(clock))).toBe('signature');

    const [header, , signature] = sign(claims()).split('.');
    const tampered = [header, b64(claims({ sub: 'usr-admin' })), signature].join('.');
    expect(failure(tampered, options(clock))).toBe('signature');
  });

  it('M1-01 alg none is rejected', () => {
    const token = [b64({ alg: 'none', typ: 'JWT', kid: KID }), b64(claims()), ''].join('.');
    expect(failure(token, options(clock))).toBe('alg');
  });

  it('M1-01 HS256 signed with the public key as the secret is rejected (algorithm confusion)', () => {
    const header = b64({ alg: 'HS256', typ: 'JWT', kid: KID });
    const payload = b64(claims());
    const secret = pair.publicKey.export({ type: 'spki', format: 'pem' });
    const mac = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    expect(failure(`${header}.${payload}.${mac}`, options(clock))).toBe('alg');
  });

  it('M1-01 other RS algorithms and a crit header are rejected', () => {
    for (const header of [{ alg: 'RS384' }, { alg: 'PS256' }, { alg: 'RS256', crit: ['exp'] }]) {
      const token = `${b64({ ...header, kid: KID })}.${b64(claims())}.${Buffer.from('x').toString('base64url')}`;
      expect(failure(token, options(clock))).toBe('alg');
    }
  });

  it('M1-01 an unknown or missing key id is rejected', () => {
    expect(
      failure(signJwt(claims(), { privateKey: pair.privateKey, kid: 'unknown' }), options(clock)),
    ).toBe('kid');
    const noKid = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims())}.${Buffer.from('x').toString('base64url')}`;
    expect(failure(noKid, options(clock))).toBe('kid');
  });

  it('M1-01 malformed tokens are rejected without an exception other than UNAUTHENTICATED', () => {
    const valid = sign(claims());
    const cases = [
      '',
      'abc',
      'a.b',
      'a.b.c.d',
      `${valid}.extra`,
      'not base64.***.***',
      `${b64([])}.${b64(claims())}.AA`,
      `${b64({ alg: 'RS256', kid: KID })}.${b64([])}.AA`,
      `${Buffer.from('{').toString('base64url')}.${b64(claims())}.AA`,
      'A'.repeat(9000),
    ];
    for (const token of cases)
      expect(failure(token, options(clock))).toMatch(/malformed|alg|signature/);
    expect(failure(valid.replace(/\./, '. .'), options(clock))).toBe('malformed');
  });

  it('M1-01 a verifier may cap the lifetime (exp - iat), so a far-future exp is refused (NFR-21)', () => {
    const capped = options(clock, { maxLifetimeSeconds: 300 });
    expect(failure(sign(claims({ exp: NOW + 300 })), capped)).toBe('accepted');
    expect(failure(sign(claims({ exp: NOW + 301 })), capped)).toBe('claims');
    expect(failure(sign(claims({ exp: NOW + 86_400 })), capped)).toBe('claims');
    expect(failure(sign(claims({ iat: undefined })), capped)).toBe('claims');
    // Without the option nothing changes, so existing callers keep their behaviour.
    expect(failure(sign(claims({ exp: NOW + 86_400 })), options(clock))).toBe('accepted');
  });

  it('M1-02 a token written in a non-canonical base64url form is rejected, so one token has one spelling', () => {
    const token = sign(claims());
    const [header = '', payload = '', signature = ''] = token.split('.');
    // The last character of a 256-byte signature carries two bits; the other four are ignored by a lenient decoder, so
    // three other characters decode to the very same bytes and the signature would still verify.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const original = Buffer.from(signature, 'base64url');
    const respelled = Array.from({ length: alphabet.length }, (_, index) => alphabet.charAt(index))
      .map((last) => signature.slice(0, -1) + last)
      .filter(
        (candidate) =>
          candidate !== signature && Buffer.from(candidate, 'base64url').equals(original),
      );
    expect(respelled.length).toBeGreaterThan(0);
    expect(failure(token, options(clock))).toBe('accepted');
    for (const candidate of respelled) {
      expect(failure([header, payload, candidate].join('.'), options(clock))).toBe('malformed');
    }
  });

  it('M1-01 a token from the future (iat) beyond the clock is rejected', () => {
    expect(failure(sign(claims({ iat: NOW + 3600 })), options(clock))).toBe('not_yet_valid');
  });
});
