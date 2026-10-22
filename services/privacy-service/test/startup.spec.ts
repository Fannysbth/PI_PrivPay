import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServiceApp } from '@privpay/common/nest';
import { privacyModules } from '../src/privacy.module';

// Seam: the service factory, as the process uses it. The three keys are read before anything listens or connects, so
// a missing file stops the start (spec privacy 3, FR-30, S-03). Every value is invented.
const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');
const KEYS = [
  ['PSEUDONYM_HMAC_SECRET_FILE', 'hmac', 1],
  ['BLIND_INDEX_SECRET_FILE', 'index', 2],
  ['FIELD_ENCRYPTION_KEY_FILE', 'field', 3],
] as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-startup-'));
  for (const [, name, byte] of KEYS) writeFileSync(join(dir, name), `${hex(byte)}\n`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  PRIVACY_MODE: 'proposed',
  PORT: '0',
  PG_HOST: '127.0.0.1',
  PG_PORT: '1',
  PG_SECRETS_DIR: dir,
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: 'privpay-dev-idp',
  GRACE_PERIOD_SECONDS: '30',
  TTL_PAYMENT_PROCESSING: '900',
  TTL_FRAUD_DETECTION: '2592000',
  TTL_NOTIFICATION: '900',
  TTL_NOTIFICATION_REGISTRATION: '31536000',
  TTL_DAILY_RECONCILIATION: '86400',
  TTL_INTERNAL_AUDIT: '600',
  DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
  RETENTION_DAYS: '90',
  RETENTION_JOB_RUN_UTC: '01:00',
  PSEUDONYM_KEY_VERSION: '1',
  PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
  BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
  FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
  ...over,
});
const start = (over: Record<string, string>) =>
  createServiceApp({ service: 'privacy-service', modules: privacyModules() }, env(over));

describe('M2-02 S-03 FR-30 the service does not start without its three key files', () => {
  it.each(KEYS)('S-03 FR-30 a missing %s stops the start before anything listens', async (name) => {
    await expect(start({ [name]: join(dir, 'absent') })).rejects.toThrow(name.replace('_FILE', ''));
  });

  it.each(KEYS)('S-03 FR-30 an unset %s stops the start', async (name) => {
    const without: Record<string, string | undefined> = { ...env(), [name]: undefined };
    await expect(
      createServiceApp({ service: 'privacy-service', modules: privacyModules() }, without),
    ).rejects.toThrow(name.replace('_FILE', ''));
  });

  it('S-03 FR-30 the refusal names the variable and never a path or a key', async () => {
    const error = await start({ BLIND_INDEX_SECRET_FILE: join(dir, 'absent') }).catch(
      (caught: unknown) => caught as Error,
    );
    expect((error as Error).message).toContain('BLIND_INDEX_SECRET');
    expect((error as Error).message).not.toContain(dir);
    for (const byte of [1, 2, 3]) expect((error as Error).message).not.toContain(hex(byte));
  });
});
