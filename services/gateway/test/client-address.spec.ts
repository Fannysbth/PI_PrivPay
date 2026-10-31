import { gatewayConfigSchema } from '../src/config';
import { clientAddress } from '../src/edge/client-address';

// DK-02a: behind Kong the socket address is Kong's, so the register limit (K-14) would be one shared bucket.
// The address Kong appended to X-Forwarded-For is used only when the operator says exactly one proxy stands in front.
const KONG = '172.20.0.5';
const CLIENT = '198.51.100.7';

describe('DK-02a clientAddress picks the address the register limit counts', () => {
  it('DK-02a with no proxy declared the socket address is used and X-Forwarded-For is ignored', () => {
    expect(clientAddress({ socket: KONG, forwardedFor: CLIENT, proxyHops: 0 })).toBe(KONG);
  });

  it('DK-02a with one proxy the last entry (the one Kong appended) is the client', () => {
    expect(clientAddress({ socket: KONG, forwardedFor: CLIENT, proxyHops: 1 })).toBe(CLIENT);
  });

  it('DK-02a a forged first entry cannot choose the bucket: only the last entry counts', () => {
    const forged = `203.0.113.9, ${CLIENT}`;
    expect(clientAddress({ socket: KONG, forwardedFor: forged, proxyHops: 1 })).toBe(CLIENT);
  });

  it('DK-02a a repeated header (array) or a missing header falls back to the socket address', () => {
    expect(clientAddress({ socket: KONG, forwardedFor: [CLIENT, CLIENT], proxyHops: 1 })).toBe(
      KONG,
    );
    expect(clientAddress({ socket: KONG, forwardedFor: undefined, proxyHops: 1 })).toBe(KONG);
  });

  it('DK-02a an entry that is not an IP address falls back to the socket address', () => {
    expect(clientAddress({ socket: KONG, forwardedFor: 'not-an-ip', proxyHops: 1 })).toBe(KONG);
    expect(clientAddress({ socket: KONG, forwardedFor: '', proxyHops: 1 })).toBe(KONG);
  });
});

describe('DK-02a EDGE_PROXY_HOPS is validated at start-up', () => {
  const hops = gatewayConfigSchema.shape.EDGE_PROXY_HOPS;
  it('DK-02a defaults to 0 and accepts only 0 or 1', () => {
    expect(hops.parse(undefined)).toBe(0);
    expect(hops.parse('1')).toBe(1);
    expect(hops.safeParse('2').success).toBe(false);
    expect(hops.safeParse('-1').success).toBe(false);
  });
});
