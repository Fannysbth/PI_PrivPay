import { loadConfig } from '../src/config';
import { httpConfigSchema } from '../src/http';

describe('M0-03 timeout and retries come from the environment, not from literals in code (CLAUDE.md, NFR-12)', () => {
  it('M0-03 defaults to a 3000 ms timeout and 2 retries', () => {
    expect(loadConfig(httpConfigSchema, {})).toEqual({ HTTP_TIMEOUT_MS: 3000, HTTP_MAX_RETRY: 2 });
  });

  it('M0-03 reads HTTP_TIMEOUT_MS and HTTP_MAX_RETRY from the environment', () => {
    const env = { HTTP_TIMEOUT_MS: '1500', HTTP_MAX_RETRY: '1' };
    expect(loadConfig(httpConfigSchema, env)).toEqual({ HTTP_TIMEOUT_MS: 1500, HTTP_MAX_RETRY: 1 });
    expect(loadConfig(httpConfigSchema, { HTTP_MAX_RETRY: '0' }).HTTP_MAX_RETRY).toBe(0);
  });

  it.each([
    { HTTP_TIMEOUT_MS: '0' },
    { HTTP_TIMEOUT_MS: 'abc' },
    { HTTP_MAX_RETRY: '3' },
    { HTTP_MAX_RETRY: '-1' },
  ])('M0-03 rejects the invalid value %j (the PRD allows at most 2 retries)', (env) => {
    expect(() => loadConfig(httpConfigSchema, env)).toThrow();
  });
});
