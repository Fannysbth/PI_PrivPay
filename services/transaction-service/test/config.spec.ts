import { loadTransactionConfig } from '../src/config';

// The settings of the jobs of the transaction service (M4-10): when they run comes from the environment, with no default, and a
// value that cannot work stops the start by name (project rules: fail fast). Values are invented.
const env = (): Record<string, string> => ({
  PRIVACY_MODE: 'proposed',
  PG_HOST: '127.0.0.1',
  PG_PORT: '5432',
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: 'privpay-dev-idp',
  FRAUD_AMOUNT_THRESHOLD: '1000000',
  TX_PENDING_TIMEOUT_SECONDS: '300',
  TX_SWEEP_INTERVAL_SECONDS: '30',
  PRIVACY_SERVICE_URL: 'http://privacy.test',
  FRAUD_SERVICE_URL: 'http://fraud.test',
  NOTIFICATION_SERVICE_URL: 'http://notification.test',
});

describe('M4-10 the schedule of the transaction jobs comes from the environment', () => {
  it.each([
    ['TX_SWEEP_INTERVAL_SECONDS', undefined],
    ['TX_SWEEP_INTERVAL_SECONDS', '0'],
    ['TX_SWEEP_INTERVAL_SECONDS', '1.5'],
    ['TX_SWEEP_INTERVAL_SECONDS', 'often'],
    ['SCHEDULER_ENABLED', 'TRUE'],
    ['SCHEDULER_ENABLED', ''],
  ])('M4-10 %s as %j stops the start, by name', (name, value) => {
    const settings = env();
    if (value === undefined) Reflect.deleteProperty(settings, name);
    else settings[name] = value;
    expect(() => loadTransactionConfig(settings)).toThrow(name);
  });

  it('M4-10 the values are read as given', () => {
    expect(loadTransactionConfig({ ...env(), SCHEDULER_ENABLED: 'false' })).toMatchObject({
      SCHEDULER_ENABLED: 'false',
    });
  });
});

describe('ADR-0020 the window T of the token cache comes from the environment', () => {
  it('ADR-0020 T is 5 seconds and the size bounded when nothing is set', () => {
    expect(loadTransactionConfig(env())).toMatchObject({
      TOKEN_CACHE_TTL_SECONDS: 5,
      TOKEN_CACHE_MAX_ENTRIES: 1000,
    });
  });

  it('ADR-0020 T can be changed (30 is the sensitivity variant, 0 switches the cache off)', () => {
    expect(loadTransactionConfig({ ...env(), TOKEN_CACHE_TTL_SECONDS: '30' })).toMatchObject({
      TOKEN_CACHE_TTL_SECONDS: 30,
    });
    expect(loadTransactionConfig({ ...env(), TOKEN_CACHE_TTL_SECONDS: '0' })).toMatchObject({
      TOKEN_CACHE_TTL_SECONDS: 0,
    });
  });

  it.each([
    ['TOKEN_CACHE_TTL_SECONDS', '-1'],
    ['TOKEN_CACHE_TTL_SECONDS', '301'],
    ['TOKEN_CACHE_TTL_SECONDS', '1.5'],
    ['TOKEN_CACHE_TTL_SECONDS', 'long'],
    ['TOKEN_CACHE_MAX_ENTRIES', '0'],
  ])('ADR-0020 %s as %j stops the start, by name', (name, value) => {
    expect(() => loadTransactionConfig({ ...env(), [name]: value })).toThrow(name);
  });
});
