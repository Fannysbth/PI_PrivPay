import { BoundedTtlCache, DomainError, FakeClock } from '@privpay/common';
import { CachedPrivacyClient } from '../src/notification/cached-privacy-client';
import type { PrivacyClient } from '../src/notification';

// ADR-0020 / ADR-0021: Notification keeps the answer of resolve-domain (P4 -> P5) for at most T seconds, keyed by the P4
// token. The answer says nothing about when the domain token ends, so only T limits the entry. Nothing sleeps.
const START = '2026-11-12T00:00:00Z';

function setup(ttlSeconds = 5) {
  const clock = new FakeClock(START);
  let calls = 0;
  let behaviour: (token: string, call: number) => Promise<string> = (token) =>
    Promise.resolve(`PSEU-D${token.slice(-7)}`);
  const inner: PrivacyClient = {
    resolveDomain: (token) => {
      calls += 1;
      return behaviour(token, calls);
    },
  };
  const client = new CachedPrivacyClient(
    inner,
    new BoundedTtlCache<string>({ clock, ttlSeconds, maxEntries: 100 }),
  );
  return {
    clock,
    client,
    calls: () => calls,
    behave: (fn: typeof behaviour) => {
      behaviour = fn;
    },
  };
}

describe('ADR-0020 the domain token of Notification is kept for T seconds', () => {
  it('ADR-0020 the same P4 token is resolved once within T', async () => {
    const t = setup();
    const first = await t.client.resolveDomain('PSEU-1111111A');
    expect(await t.client.resolveDomain('PSEU-1111111A')).toBe(first);
    expect(t.calls()).toBe(1);
  });

  it('ADR-0020 another P4 token is another key (invariant 5: no join through one entry)', async () => {
    const t = setup();
    const a = await t.client.resolveDomain('PSEU-1111111A');
    const b = await t.client.resolveDomain('PSEU-2222222B');
    expect(a).not.toBe(b);
    expect(t.calls()).toBe(2);
  });

  it('ADR-0021 after T seconds Privacy is asked again', async () => {
    const t = setup(5);
    await t.client.resolveDomain('PSEU-1111111A');
    t.clock.advance(4.9);
    await t.client.resolveDomain('PSEU-1111111A');
    expect(t.calls()).toBe(1);
    t.clock.advance(0.2);
    await t.client.resolveDomain('PSEU-1111111A');
    expect(t.calls()).toBe(2);
  });

  it('ADR-0020 T = 0 is the old behaviour: every call goes to Privacy', async () => {
    const t = setup(0);
    await t.client.resolveDomain('PSEU-1111111A');
    await t.client.resolveDomain('PSEU-1111111A');
    expect(t.calls()).toBe(2);
  });

  it('ADR-0021 a refusal or an outage is not stored and reaches the caller', async () => {
    const t = setup();
    t.behave(() => Promise.reject(new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer')));
    await expect(t.client.resolveDomain('PSEU-1111111A')).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
    await expect(t.client.resolveDomain('PSEU-1111111A')).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
    expect(t.calls()).toBe(2);
  });

  it('ADR-0021 TK-16 Privacy down: cold fails closed at once, warm holds for T seconds, then fails closed again', async () => {
    const t = setup(5);
    t.behave(() => Promise.reject(new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer')));
    await expect(t.client.resolveDomain('PSEU-1111111A')).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
    t.behave(() => Promise.resolve('PSEU-D0000001'));
    expect(await t.client.resolveDomain('PSEU-1111111A')).toBe('PSEU-D0000001');
    t.behave(() => Promise.reject(new DomainError('SERVICE_UNAVAILABLE', 'privacy_answer')));
    t.clock.advance(4);
    expect(await t.client.resolveDomain('PSEU-1111111A')).toBe('PSEU-D0000001');
    t.clock.advance(1.1);
    await expect(t.client.resolveDomain('PSEU-1111111A')).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
  });
});
