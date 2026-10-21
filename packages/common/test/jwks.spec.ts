import { generateKeyPairSync } from 'node:crypto';
import { DomainError, FakeClock } from '../src';
import { JwksKeys, type JwksSource } from '../src/jwks';

// Public keys the way the dev IdP publishes them; made for the run.
const a = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (pair: typeof a, kid: string): unknown => ({
  ...pair.publicKey.export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
});

describe('M1-03 JwksKeys finds the public key of a token and refreshes at most once per cooldown', () => {
  let clock: FakeClock;
  let published: unknown;
  let calls: number;
  let failing: boolean;
  /** When set, a fetch waits for it: a slow IdP. */
  let hold: Promise<void> | undefined;
  const source: JwksSource = {
    fetch: async () => {
      calls += 1;
      if (hold !== undefined) await hold;
      if (failing) throw new Error('idp down at http://127.0.0.1:1');
      return published;
    },
  };
  beforeEach(() => {
    clock = new FakeClock(new Date('2026-10-19T08:00:00Z'));
    published = { keys: [jwk(a, 'k1')] };
    calls = 0;
    failing = false;
    hold = undefined;
  });
  const keys = (): JwksKeys =>
    new JwksKeys({ source, clock, cooldownSeconds: 30, maxAgeSeconds: 300 });

  it('M1-03 loads on first use and then answers from memory', async () => {
    const store = keys();
    await store.ensure('k1');
    await store.ensure('k1');
    expect(calls).toBe(1);
    expect(store.resolveKey('k1')?.type).toBe('public');
  });

  it('M1-03 an unknown key id triggers one refresh, then waits out the cooldown', async () => {
    const store = keys();
    await store.ensure('k1');
    published = { keys: [jwk(a, 'k1'), jwk(b, 'k2')] };
    await store.ensure('k2');
    expect(store.resolveKey('k2')).toBeDefined();
    expect(calls).toBe(2);

    await store.ensure('nope');
    await store.ensure('nope');
    expect(calls).toBe(2);
    clock.advance(30);
    await store.ensure('nope');
    expect(calls).toBe(3);
    expect(store.resolveKey('nope')).toBeUndefined();
  });

  it('M1-03 a key the issuer rotated out stops being accepted after the next refresh', async () => {
    const store = keys();
    await store.ensure('k1');
    published = { keys: [jwk(b, 'k2')] };
    clock.advance(30);
    await store.ensure('k2');
    expect(store.resolveKey('k1')).toBeUndefined();
    expect(store.resolveKey('k2')).toBeDefined();
  });

  it('M1-03 an IdP that cannot be reached is SERVICE_UNAVAILABLE without its address or message', async () => {
    failing = true;
    const store = keys();
    const error = await store.ensure('k1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).reason).toBe('SERVICE_UNAVAILABLE');
    expect(`${(error as Error).message} ${String((error as Error).cause)}`).not.toContain(
      '127.0.0.1',
    );
  });

  it('M1-03 a failed load is retried after the cooldown and keeps the keys it already had', async () => {
    const store = keys();
    await store.ensure('k1');
    failing = true;
    clock.advance(30);
    await store.ensure('unknown').catch(() => undefined);
    expect(store.resolveKey('k1')).toBeDefined();
    failing = false;
    clock.advance(30);
    await store.ensure('unknown');
    expect(calls).toBe(3);
  });

  it.each([
    ['not an object', 'text'],
    ['no keys list', {}],
    ['keys that are not a list', { keys: 'x' }],
    [
      'a private key (d present)',
      { keys: [{ ...(jwk(a, 'k1') as object), d: 'secret-material' }] },
    ],
    ['a key that is not RSA', { keys: [{ kty: 'oct', k: 'AAAA', kid: 'k1' }] }],
    ['a key without kid', { keys: [{ ...(jwk(a, 'k1') as object), kid: undefined }] }],
    ['a key for another algorithm', { keys: [{ ...(jwk(a, 'k1') as object), alg: 'HS256' }] }],
  ])('M1-03 a JWKS with %s is refused and publishes no key', async (_name, body) => {
    published = body;
    const store = keys();
    await expect(store.ensure('k1')).rejects.toBeInstanceOf(DomainError);
    expect(store.resolveKey('k1')).toBeUndefined();
  });

  it('M1-03 two requests for an unknown key at the same time share one fetch', async () => {
    const store = keys();
    await Promise.all([store.ensure('k1'), store.ensure('k1'), store.ensure('other')]);
    expect(calls).toBe(1);
  });

  it('M1-03 FR-01 a key the IdP no longer lists stops being trusted once the keys are older than the maximum age', async () => {
    const store = keys();
    await store.ensure('k1');
    published = { keys: [jwk(b, 'k2')] };
    // Still within the age: a known key id is answered from memory.
    clock.advance(299);
    await store.ensure('k1');
    expect(store.resolveKey('k1')).toBeDefined();
    expect(calls).toBe(1);
    // Past it: even a known key id makes the keys reload, and the rotated-out key is gone.
    clock.advance(1);
    await store.ensure('k1');
    expect(calls).toBe(2);
    expect(store.resolveKey('k1')).toBeUndefined();
    expect(store.resolveKey('k2')).toBeDefined();
  });

  it('M1-03 FR-01 keys that are too old and cannot be renewed are not trusted: SERVICE_UNAVAILABLE (fail closed)', async () => {
    const store = keys();
    await store.ensure('k1');
    failing = true;
    clock.advance(300);
    const error = await store.ensure('k1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).reason).toBe('SERVICE_UNAVAILABLE');
    expect(store.resolveKey('k1')).toBeUndefined();
    // After the cooldown the IdP is tried again and the keys come back.
    failing = false;
    clock.advance(30);
    await store.ensure('k1');
    expect(store.resolveKey('k1')).toBeDefined();
  });

  it('M1-03 a request with a known key id is not held up, or failed, by a reload that an unknown key id started', async () => {
    const store = keys();
    await store.ensure('k1');
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    failing = true;
    // An attacker's random key id starts a reload at a slow, failing IdP.
    const reload = store.ensure('random-kid').catch((e: unknown) => e);
    // A legitimate caller with a key we hold must be answered at once, without waiting for that reload.
    const settled = await Promise.race([
      store.ensure('k1').then(() => 'answered'),
      new Promise<string>((resolve) => {
        setImmediate(() => {
          resolve('still waiting');
        });
      }),
    ]);
    expect(settled).toBe('answered');
    expect(store.resolveKey('k1')).toBeDefined();
    release();
    expect(await reload).toBeInstanceOf(DomainError);
    // The failed reload did not take away the keys we already trusted.
    expect(store.resolveKey('k1')).toBeDefined();
  });
});
