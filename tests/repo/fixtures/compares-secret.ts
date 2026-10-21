// Deliberately wrong: every comparison below leaks timing information about a secret (M1-02).
export function check(
  clientSecret: string,
  expected: string,
  hmac: Buffer,
  other: Buffer,
  request: { client_secret: string },
): boolean[] {
  return [
    clientSecret === expected,
    expected !== clientSecret,
    request.client_secret == expected,
    hmac.equals(other),
    expected === request.client_secret,
    // The secret as the argument instead of the receiver, a string key, and Buffer.compare.
    other.equals(hmac),
    Buffer.compare(other, hmac) === 0,
    request['client_secret'] === expected,
  ];
}
