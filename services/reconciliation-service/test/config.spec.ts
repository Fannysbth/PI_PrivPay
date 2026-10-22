import { loadReconciliationConfig } from '../src/config';

// The settings of the jobs of the reconciliation service (M4-10): when they run comes from the environment, with no default, and a
// value that cannot work stops the start by name (CLAUDE.md: fail fast). Values are invented.
const env = (): Record<string, string> => ({
  PRIVACY_MODE: 'proposed',
  PG_HOST: '127.0.0.1',
  PG_PORT: '5432',
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: 'privpay-dev-idp',
  RECON_DAILY_RUN_UTC: '00:10',
  PRIVACY_SERVICE_URL: 'http://privacy.test',
  TRANSACTION_SERVICE_URL: 'http://transaction.test',
});

describe('M4-10 the schedule of the reconciliation jobs comes from the environment', () => {
  it.each([
    ['RECON_DAILY_RUN_UTC', undefined],
    ['RECON_DAILY_RUN_UTC', '24:00'],
    ['RECON_DAILY_RUN_UTC', '0:10'],
    ['RECON_DAILY_RUN_UTC', '00:10:00'],
    ['SCHEDULER_ENABLED', 'TRUE'],
    ['SCHEDULER_ENABLED', ''],
  ])('M4-10 %s as %j stops the start, by name', (name, value) => {
    const settings = env();
    if (value === undefined) Reflect.deleteProperty(settings, name);
    else settings[name] = value;
    expect(() => loadReconciliationConfig(settings)).toThrow(name);
  });

  it('M4-10 the values are read as given', () => {
    expect(loadReconciliationConfig({ ...env(), SCHEDULER_ENABLED: 'false' })).toMatchObject({
      SCHEDULER_ENABLED: 'false',
    });
  });
});
