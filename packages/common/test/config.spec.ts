import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError, loadConfig, readKey, readSecret } from '../src/config';

const CANARY = 'canary-secret-9f3a1c7e5b2d4a6c8e0f1a3b5c7d9e1f';

const schema = z.object({
  PRIVACY_MODE: z.enum(['baseline', 'proposed']),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive(),
  LOG_LEVEL: z.string().default('info'),
});

function catchConfigError(action: () => unknown): ConfigError {
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('M0-02 loadConfig (E-09, NFR-22)', () => {
  it('M0-02 returns typed values, coerces numbers, and applies defaults', () => {
    const config = loadConfig(schema, { PRIVACY_MODE: 'proposed', HTTP_TIMEOUT_MS: '3000' });
    expect(config).toEqual({ PRIVACY_MODE: 'proposed', HTTP_TIMEOUT_MS: 3000, LOG_LEVEL: 'info' });
  });

  it('M0-02 fails fast and names every missing variable', () => {
    const error = catchConfigError(() => loadConfig(schema, {}));
    expect(error.issues).toEqual(
      expect.arrayContaining([
        { name: 'PRIVACY_MODE', problem: 'missing' },
        { name: 'HTTP_TIMEOUT_MS', problem: 'missing' },
      ]),
    );
  });

  it('M0-02 reports an empty variable as empty', () => {
    const error = catchConfigError(() =>
      loadConfig(schema, { PRIVACY_MODE: 'proposed', HTTP_TIMEOUT_MS: '' }),
    );
    expect(error.issues).toContainEqual({ name: 'HTTP_TIMEOUT_MS', problem: 'empty' });
  });

  it('M0-02 rejects an invalid value without ever printing it', () => {
    const error = catchConfigError(() =>
      loadConfig(schema, { PRIVACY_MODE: `static-${CANARY}`, HTTP_TIMEOUT_MS: '3000' }),
    );
    expect(error.issues).toContainEqual({ name: 'PRIVACY_MODE', problem: 'invalid' });
    expect(error.message).not.toContain(CANARY);
    expect(JSON.stringify(error.issues)).not.toContain(CANARY);
  });

  it('M0-02 rejects unknown variables under a declared prefix (typos) and ignores unrelated ones', () => {
    const env = {
      PRIVACY_MODE: 'proposed',
      HTTP_TIMEOUT_MS: '3000',
      HTTP_TIMEOUT_MSS: '1',
      PATH: '/usr/bin',
    };
    const error = catchConfigError(() => loadConfig(schema, env, { strictPrefixes: ['HTTP_'] }));
    expect(error.issues).toEqual([{ name: 'HTTP_TIMEOUT_MSS', problem: 'unknown' }]);
    expect(loadConfig(schema, env).HTTP_TIMEOUT_MS).toBe(3000);
  });
});

describe('M0-02 readSecret and readKey read secrets from files, never raw env (NFR-22)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privpay-config-'));
  const file = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('M0-02 reads the file named by NAME_FILE and strips the trailing newline', () => {
    const env = { SECRET_A_FILE: file('a', `${CANARY}\n`) };
    expect(readSecret(env, 'SECRET_A')).toBe(CANARY);
  });

  it('M0-02 fails when NAME_FILE is not set', () => {
    const error = catchConfigError(() => readSecret({}, 'SECRET_A'));
    expect(error.issues).toEqual([{ name: 'SECRET_A_FILE', problem: 'missing' }]);
  });

  it('M0-02 fails when the file does not exist', () => {
    const error = catchConfigError(() =>
      readSecret({ SECRET_A_FILE: join(dir, 'does-not-exist') }, 'SECRET_A'),
    );
    expect(error.issues).toEqual([{ name: 'SECRET_A_FILE', problem: 'unreadable' }]);
  });

  it('M0-02 fails when the file is empty', () => {
    const error = catchConfigError(() =>
      readSecret({ SECRET_A_FILE: file('empty', '\n') }, 'SECRET_A'),
    );
    expect(error.issues).toEqual([{ name: 'SECRET_A_FILE', problem: 'empty' }]);
  });

  it('M0-02 rejects a raw secret value in the environment and never echoes it', () => {
    const error = catchConfigError(() =>
      readSecret({ SECRET_A: CANARY, SECRET_A_FILE: file('b', 'x') }, 'SECRET_A'),
    );
    expect(error.issues).toEqual([{ name: 'SECRET_A', problem: 'raw_secret_forbidden' }]);
    expect(error.message).not.toContain(CANARY);
  });

  it('M0-02 decodes a hex key of the required length', () => {
    const hex = 'ab'.repeat(32);
    const key = readKey({ KEY_FILE: file('key', `${hex}\n`) }, 'KEY', 32);
    expect(key).toHaveLength(32);
    expect(key.toString('hex')).toBe(hex);
  });

  it('M0-02 rejects a key of the wrong length or with non-hex characters without printing it', () => {
    const short = catchConfigError(() =>
      readKey({ KEY_FILE: file('short', 'ab'.repeat(16)) }, 'KEY', 32),
    );
    expect(short.issues).toEqual([{ name: 'KEY_FILE', problem: 'invalid' }]);
    const notHex = catchConfigError(() =>
      readKey({ KEY_FILE: file('nothex', `zz${CANARY}`.padEnd(64, 'z')) }, 'KEY', 32),
    );
    expect(notHex.issues).toEqual([{ name: 'KEY_FILE', problem: 'invalid' }]);
    expect(notHex.message).not.toContain(CANARY);
  });
});
