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
