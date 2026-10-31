import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DK-02a (NFR-06): Kong terminates TLS at the edge with a certificate of the same development CA that already signs the
// Privacy Service's. The files are made by the `openssl` helper into a throwaway folder; nothing is stored in git.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tls = require('../../scripts/docker/tls.cjs') as {
  makeComposeTls(dir: string, out?: (line: string) => void): boolean;
  TLS_SECRETS: Record<string, string>;
};

const certificate = (dir: string, file: string): X509Certificate =>
  new X509Certificate(readFileSync(join(dir, file)));

describe('DK-02a the Kong edge certificate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'privpay-kong-tls-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('DK-02a is a Compose secret pair next to the existing ones', () => {
    expect(tls.TLS_SECRETS['tls_kong_crt']).toBe('tls_kong.crt');
    expect(tls.TLS_SECRETS['tls_kong_key']).toBe('tls_kong.key');
  });

  it('DK-02a is signed by the dev CA and valid for the service name, localhost and 127.0.0.1 (Postman, Newman)', () => {
    tls.makeComposeTls(dir);
    const kong = certificate(dir, 'tls_kong.crt');
    const ca = certificate(dir, 'tls_ca.crt');
    expect(kong.verify(ca.publicKey)).toBe(true);
    expect(kong.checkHost('kong')).toBe('kong');
    expect(kong.checkHost('localhost')).toBe('localhost');
    expect(kong.checkIP('127.0.0.1')).toBe('127.0.0.1');
    // Not a certificate for anything else: a client that connects by another name must reject it.
    expect(kong.checkHost('example.test')).toBeUndefined();
    expect(kong.ca).toBe(false);
  });

  it('DK-02a an install that has only the earlier files gets the Kong pair from the same CA, and keeps what it had', () => {
    tls.makeComposeTls(dir);
    const before = readFileSync(join(dir, 'tls_privacy.crt'), 'utf8');
    unlinkSync(join(dir, 'tls_kong.crt'));
    unlinkSync(join(dir, 'tls_kong.key'));
    expect(tls.makeComposeTls(dir)).toBe(true);
    expect(readFileSync(join(dir, 'tls_privacy.crt'), 'utf8')).toBe(before);
    expect(certificate(dir, 'tls_kong.crt').verify(certificate(dir, 'tls_ca.crt').publicKey)).toBe(
      true,
    );
  });

  it('DK-02a a second run changes nothing, and half a Kong pair is refused rather than completed', () => {
    tls.makeComposeTls(dir);
    expect(tls.makeComposeTls(dir)).toBe(false);
    unlinkSync(join(dir, 'tls_kong.key'));
    expect(() => tls.makeComposeTls(dir)).toThrow(/incomplete/);
    expect(existsSync(join(dir, 'tls_kong.crt'))).toBe(true);
  });
});
