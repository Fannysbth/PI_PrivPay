import { loadTransactionConfig } from '../src/config';

// The settings of the jobs of the transaction service (M4-10): when they run comes from the environment, with no default, and a
// value that cannot work stops the start by name (CLAUDE.md: fail fast). Values are invented.
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
