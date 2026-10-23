import { loadPrivacyConfig } from '../src/config';

// The settings the privacy service refuses to start without: no default for a TTL, the grace period or the approval
// window (CLAUDE.md: fail fast). Values are invented.
const env = (): Record<string, string> => ({
  PRIVACY_MODE: 'proposed',
  PG_HOST: '127.0.0.1',
  PG_PORT: '5432',
  IDP_URL: 'http://idp.test',
  IDP_ISSUER: 'privpay-dev-idp',
  GRACE_PERIOD_SECONDS: '30',
  PSEUDONYM_KEY_VERSION: '1',
  TTL_PAYMENT_PROCESSING: '900',
  TTL_FRAUD_DETECTION: '2592000',
  TTL_NOTIFICATION: '900',
  TTL_NOTIFICATION_REGISTRATION: '31536000',
  TTL_DAILY_RECONCILIATION: '86400',
  TTL_INTERNAL_AUDIT: '600',
  DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
  RETENTION_DAYS: '90',
  RETENTION_JOB_RUN_UTC: '01:00',
});

describe('M3-04 FR-09 the disclosure approval window comes from the environment, with no default', () => {
  it('M3-04 FR-09 DISCLOSURE_APPROVAL_TTL_SECONDS is read as whole seconds', () => {
    expect(loadPrivacyConfig(env()).DISCLOSURE_APPROVAL_TTL_SECONDS).toBe(600);
  });

  it.each([
    ['missing', undefined],
    ['zero', '0'],
    ['negative', '-5'],
    ['not a number', 'ten minutes'],
  ])('M3-04 FR-09 a value that is %s stops the start', (_name, value) => {
    const settings = env();
    if (value === undefined) Reflect.deleteProperty(settings, 'DISCLOSURE_APPROVAL_TTL_SECONDS');
    else settings['DISCLOSURE_APPROVAL_TTL_SECONDS'] = value;
    expect(() => loadPrivacyConfig(settings)).toThrow('DISCLOSURE_APPROVAL_TTL_SECONDS');
  });
});

describe('M4-10 K-26 the retention job: how long and when, from the environment, with no default', () => {
  it.each([
    ['RETENTION_DAYS', undefined],
    ['RETENTION_DAYS', '0'],
    ['RETENTION_DAYS', 'ninety'],
    ['RETENTION_JOB_RUN_UTC', undefined],
    ['RETENTION_JOB_RUN_UTC', '24:00'],
    ['RETENTION_JOB_RUN_UTC', '1:00'],
    ['RETENTION_JOB_RUN_UTC', '01:00:00'],
    ['SCHEDULER_ENABLED', 'TRUE'],
    ['SCHEDULER_ENABLED', '1'],
  ])('M4-10 %s as %j stops the start, by name', (name, value) => {
    const settings = env();
    if (value === undefined) Reflect.deleteProperty(settings, name);
    else settings[name] = value;
    expect(() => loadPrivacyConfig(settings)).toThrow(name);
  });

  it('M4-10 the values are read as given, and the jobs may be switched on or off by name', () => {
    const config = loadPrivacyConfig({ ...env(), SCHEDULER_ENABLED: 'true' });
    expect(config).toMatchObject({
      RETENTION_DAYS: 90,
      RETENTION_JOB_RUN_UTC: '01:00',
      SCHEDULER_ENABLED: 'true',
    });
  });
});

describe('M5-02 ADR-0006 the privacy service is the privacy layer, so it runs in proposed only', () => {
  it('M5-02 ADR-0006 PRIVACY_MODE=proposed starts', () => {
    expect(loadPrivacyConfig(env()).PRIVACY_MODE).toBe('proposed');
  });

  it('M5-02 ADR-0006 PRIVACY_MODE=baseline does not start and names only the variable', () => {
    const settings = env();
    settings['PRIVACY_MODE'] = 'baseline';
    expect(() => loadPrivacyConfig(settings)).toThrow('PRIVACY_MODE');
  });

  it('M5-02 ADR-0006 a missing PRIVACY_MODE does not start', () => {
    const settings = env();
    Reflect.deleteProperty(settings, 'PRIVACY_MODE');
    expect(() => loadPrivacyConfig(settings)).toThrow('PRIVACY_MODE');
  });
});
