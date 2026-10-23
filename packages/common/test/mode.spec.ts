import { z } from 'zod';
import {
  ConfigError,
  PRIVACY_MODES,
  loadConfig,
  privacyUrlMatchesMode,
  subjectRefShape,
  type PrivacyMode,
} from '../src';

// M5-02 / ADR-0006: what a mode changes at the edge of a service. The shapes below are the only places where the two
// modes may accept different strings; the env rule keeps a half-switched configuration from starting.
const CUSTOMER_TOKEN = ['PSEU', '7BCD04F2'].join('-');
const CUSTOMER_ID = ['CUST', '000101'].join('-');
const ACCOUNT_NUMBER = '1234567801';

describe('M5-02 N-44 the form of a subject reference per mode', () => {
  it('M5-02 FR-23 proposed accepts a token for a customer and for an account, and not an identifier', () => {
    const shape = subjectRefShape('proposed');
    expect(shape.customer.test(CUSTOMER_TOKEN)).toBe(true);
    expect(shape.account.test(CUSTOMER_TOKEN)).toBe(true);
    expect(shape.customer.test(CUSTOMER_ID)).toBe(false);
    expect(shape.account.test(ACCOUNT_NUMBER)).toBe(false);
  });

  it('M5-02 FR-23 baseline accepts the customer id and the account number, and not a token', () => {
    const shape = subjectRefShape('baseline');
    expect(shape.customer.test(CUSTOMER_ID)).toBe(true);
    expect(shape.account.test(ACCOUNT_NUMBER)).toBe(true);
    expect(shape.customer.test(CUSTOMER_TOKEN)).toBe(false);
    expect(shape.account.test(CUSTOMER_TOKEN)).toBe(false);
  });

  it.each(PRIVACY_MODES.map((mode) => [mode]))(
    'M5-02 FR-23 %s refuses text around a valid reference and an empty one',
    (mode) => {
      const shape = subjectRefShape(mode);
      const good = mode === 'proposed' ? CUSTOMER_TOKEN : CUSTOMER_ID;
      expect(shape.customer.test(`${good} `)).toBe(false);
      expect(shape.customer.test(`x${good}`)).toBe(false);
      expect(shape.customer.test('')).toBe(false);
    },
  );
});

describe('M5-02 ADR-0006 the Privacy address belongs to proposed only', () => {
  const schema = z
    .object({
      PRIVACY_MODE: z.enum(PRIVACY_MODES),
      PRIVACY_SERVICE_URL: z.url().optional(),
    })
    .superRefine(privacyUrlMatchesMode);
  const load = (env: Record<string, string>) => () => loadConfig(schema, env);
  const issuesOf = (mode: PrivacyMode, extra: Record<string, string>) => {
    try {
      loadConfig(schema, { PRIVACY_MODE: mode, ...extra });
    } catch (error) {
      return (error as ConfigError).issues;
    }
    return [];
  };

  it('M5-02 proposed with the address starts, baseline without it starts', () => {
    expect(
      load({ PRIVACY_MODE: 'proposed', PRIVACY_SERVICE_URL: 'http://privacy.test' }),
    ).not.toThrow();
    expect(load({ PRIVACY_MODE: 'baseline' })).not.toThrow();
  });

  it('M5-02 proposed without the address does not start and names only the variable', () => {
    expect(issuesOf('proposed', {})).toEqual([{ name: 'PRIVACY_SERVICE_URL', problem: 'missing' }]);
  });

  it('M5-02 baseline with the address does not start and names only the variable', () => {
    expect(issuesOf('baseline', { PRIVACY_SERVICE_URL: 'http://privacy.test' })).toEqual([
      { name: 'PRIVACY_SERVICE_URL', problem: 'invalid' },
    ]);
  });
});
