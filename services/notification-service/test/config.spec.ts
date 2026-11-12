import { loadConfig } from '@privpay/common';
import { notificationConfigSchema } from '../src/config';

// ADR-0020: the window T of the domain-token cache comes from the environment, like in Transaction. The secret file of the
// client is not read here (loadNotificationConfig); only the schema is. Values are invented.
const env = (): Record<string, string> => ({
  PRIVACY_MODE: 'proposed',
  PG_HOST: '127.0.0.1',
  PG_PORT: '5432',
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: 'privpay-dev-idp',
  PRIVACY_SERVICE_URL: 'http://privacy.test',
  SMS_SIMULATOR_URL: 'http://sms.test',
});
const load = (over: Record<string, string> = {}) =>
  loadConfig(notificationConfigSchema, { ...env(), ...over });

describe('ADR-0020 the window T of the Notification cache comes from the environment', () => {
  it('ADR-0020 T is 5 seconds and the size bounded when nothing is set', () => {
    expect(load()).toMatchObject({ TOKEN_CACHE_TTL_SECONDS: 5, TOKEN_CACHE_MAX_ENTRIES: 1000 });
  });

  it('ADR-0020 T can be changed (30 is the sensitivity variant, 0 switches the cache off)', () => {
    expect(load({ TOKEN_CACHE_TTL_SECONDS: '30' })).toMatchObject({ TOKEN_CACHE_TTL_SECONDS: 30 });
    expect(load({ TOKEN_CACHE_TTL_SECONDS: '0' })).toMatchObject({ TOKEN_CACHE_TTL_SECONDS: 0 });
  });

  it.each([
    ['TOKEN_CACHE_TTL_SECONDS', '-1'],
    ['TOKEN_CACHE_TTL_SECONDS', '301'],
    ['TOKEN_CACHE_TTL_SECONDS', '1.5'],
    ['TOKEN_CACHE_TTL_SECONDS', 'long'],
    ['TOKEN_CACHE_MAX_ENTRIES', '0'],
  ])('ADR-0020 %s as %j stops the start, by name', (name, value) => {
    expect(() => load({ [name]: value })).toThrow(name);
  });
});
