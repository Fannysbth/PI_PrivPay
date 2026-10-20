export type CryptoFailure = 'bad_key' | 'integrity' | 'unknown_key_version' | 'malformed';

/**
 * `reason` is a fixed word and `detail` names what was wrong, never a value, a key or a blob: the message ends up in
 * logs (invariant 6, NFR-07). Callers map every CryptoError to a 500 that tells the client nothing (spec privacy 11).
 */
export class CryptoError extends Error {
  constructor(
    readonly reason: CryptoFailure,
    detail: string,
  ) {
    super(`crypto ${reason}: ${detail}`);
    this.name = 'CryptoError';
  }
}
