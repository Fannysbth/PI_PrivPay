import { isIP } from 'node:net';

export interface ClientAddressInput {
  /** The address of the connection (Kong's, when Kong stands in front). */
  readonly socket: string;
  readonly forwardedFor: string | readonly string[] | undefined;
  /** `EDGE_PROXY_HOPS`: how many trusted proxies are in front; 0 means X-Forwarded-For is not believed. */
  readonly proxyHops: number;
}

/**
 * The address a per-client limit counts (K-14). Behind exactly one trusted proxy (Kong) the last entry of
 * X-Forwarded-For is the one that proxy appended itself; earlier entries come from the client and may be forged.
 * Anything unexpected falls back to the socket address, so a bad header can only lose precision, never choose a bucket.
 */
export function clientAddress({ socket, forwardedFor, proxyHops }: ClientAddressInput): string {
  if (proxyHops !== 1 || typeof forwardedFor !== 'string') return socket;
  const last = forwardedFor.split(',').pop()?.trim() ?? '';
  return isIP(last) === 0 ? socket : last;
}
