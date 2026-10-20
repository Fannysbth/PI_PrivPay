import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@privpay/common';
import { loadDevIdpConfig, readServiceSecrets } from '../src/config';
import { SERVICE_CLIENTS } from '../src/registry';

const enabled = { DEV_IDP_ENABLED: 'true', NODE_ENV: 'development' };
const problem = (env: Record<string, string | undefined>): string => {
  try {
    loadDevIdpConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return 'accepted';
};

describe('M1-01 the dev IdP refuses to start outside the local phase (ADR-0004, NFR-21)', () => {
  it('M1-01 starts only when DEV_IDP_ENABLED is exactly true', () => {
    expect(problem({})).toContain('DEV_IDP_ENABLED (missing)');
    for (const value of ['false', 'TRUE', 'True', '1', 'yes', ' true']) {
      expect(problem({ DEV_IDP_ENABLED: value })).toContain('DEV_IDP_ENABLED (invalid)');
    }
    expect(problem(enabled)).toBe('accepted');
  });

  it('M1-01 NODE_ENV must be named and be development or test: an unset or unknown environment is not local', () => {
    const withoutNodeEnv: Record<string, string> = { ...enabled };
    Reflect.deleteProperty(withoutNodeEnv, 'NODE_ENV');
    expect(problem(withoutNodeEnv)).toContain('NODE_ENV (missing)');
    for (const value of ['staging', 'prod', 'live', 'local', 'devel']) {
      expect(problem({ ...enabled, NODE_ENV: value })).toContain('NODE_ENV (invalid)');
    }
    expect(problem({ ...enabled, NODE_ENV: 'Development' })).toBe('accepted');
    expect(problem({ ...enabled, NODE_ENV: ' TEST ' })).toBe('accepted');
  });

  it('M1-01 refuses NODE_ENV=production even when it is enabled', () => {
    for (const value of ['production', 'Production', 'PRODUCTION', ' production ']) {
      expect(problem({ ...enabled, NODE_ENV: value })).toContain('NODE_ENV (invalid)');
    }
    expect(problem({ ...enabled, NODE_ENV: 'development' })).toBe('accepted');
    expect(problem({ ...enabled, NODE_ENV: 'test' })).toBe('accepted');
  });

  it('M1-01 the token lifetime defaults to 300 seconds and can be at most 300', () => {
    expect(loadDevIdpConfig(enabled).ACCESS_TOKEN_TTL_SECONDS).toBe(300);
    expect(
      loadDevIdpConfig({ ...enabled, ACCESS_TOKEN_TTL_SECONDS: '60' }).ACCESS_TOKEN_TTL_SECONDS,
    ).toBe(60);
    for (const value of ['301', '0', '-5', '1.5', 'abc']) {
      expect(problem({ ...enabled, ACCESS_TOKEN_TTL_SECONDS: value })).toContain(
        'ACCESS_TOKEN_TTL_SECONDS (invalid)',
      );
    }
  });

  it('M1-01 the message names variables only, never their values', () => {
    expect(problem({ DEV_IDP_ENABLED: 'fake-value-do-not-print' })).not.toContain(
      'fake-value-do-not-print',
    );
  });
});

describe('M1-01 client secrets come from files in the secrets directory, not from the environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'privpay-idp-secrets-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const dirWith = (secrets: Record<string, string>): string => {
    const dir = join(root, String(Math.random()).slice(2));
    mkdirSync(dir);
    for (const [client, secret] of Object.entries(secrets))
      writeFileSync(join(dir, `${client}_client_secret`), `${secret}\n`);
    return dir;
  };
  const all = (): Record<string, string> =>
    Object.fromEntries(
      SERVICE_CLIENTS.map((client) => [client, `fake-secret-${client}-0123456789abcdef`]),
    );

  it('M1-01 reads <client>_client_secret for each service account', () => {
    const secrets = readServiceSecrets(dirWith(all()));
    expect(secrets['api-gateway']).toBe('fake-secret-api-gateway-0123456789abcdef');
    expect(Object.keys(secrets).sort()).toEqual([...SERVICE_CLIENTS].sort());
  });

  it('M1-01 a missing file stops the start and names the variable, not the path or the value', () => {
    const rest = Object.fromEntries(Object.entries(all()).filter(([client]) => client !== 'fraud'));
    let message = '';
    try {
      readServiceSecrets(dirWith(rest));
    } catch (error) {
      message = error instanceof ConfigError ? error.message : '';
    }
    expect(message).toContain('FRAUD_CLIENT_SECRET_FILE');
    expect(message).not.toContain(root);
  });

  it('M1-01 a secret shorter than 16 characters is refused', () => {
    const dir = dirWith({ ...all(), fraud: 'short' });
    expect(() => readServiceSecrets(dir)).toThrow(ConfigError);
    expect(() => readServiceSecrets(dir)).toThrow('FRAUD_CLIENT_SECRET_FILE (invalid)');
  });

  it('M1-01 two clients may not share one secret', () => {
    const dir = dirWith({ ...all(), fraud: all()['transaction'] ?? '' });
    expect(() => readServiceSecrets(dir)).toThrow(ConfigError);
  });
});
