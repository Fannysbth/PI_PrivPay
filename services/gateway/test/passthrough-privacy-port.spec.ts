import { DomainError } from '@privpay/common';
import { baselinePrivacyPort } from '../src/baseline';

// Seam: the baseline port of the gateway (M5-03, gateway spec 8). It hands the identity on, but only an identity of the
// form of the baseline mode: a malformed claim or account is refused here, at the edge, with the same VALIDATION_ERROR
// the schema gives, and not left to be refused by Transaction after the request has been spent. Values are invented.
const CUSTOMER_ID = ['CUST', '000101'].join('-');
const TOKEN = ['PSEU', '7BCD04F2'].join('-');
const context = { targetService: 'TRANSACTION', purpose: 'PAYMENT_PROCESSING' };

describe('M5-03 FR-23 the baseline port checks the form of what it passes on', () => {
  const port = baselinePrivacyPort('baseline');

  it('M5-03 a customer id and an account number are returned as they are', async () => {
    await expect(
      port.pseudonymize({ subjectType: 'CUSTOMER', subjectId: CUSTOMER_ID, ...context }),
    ).resolves.toBe(CUSTOMER_ID);
    await expect(
      port.pseudonymize({ subjectType: 'ACCOUNT', subjectId: '1234567801', ...context }),
    ).resolves.toBe('1234567801');
  });

  it.each([
    ['CUSTOMER', TOKEN],
    ['CUSTOMER', 'cust-000101'],
    ['CUSTOMER', ''],
    ['ACCOUNT', TOKEN],
    ['ACCOUNT', '123'],
    ['ACCOUNT', '12345678901234567890123'],
  ] as const)('M5-03 a %s of %j is VALIDATION_ERROR', async (subjectType, subjectId) => {
    const refused = await port
      .pseudonymize({ subjectType, subjectId, ...context })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainError);
    expect((refused as DomainError).reason).toBe('VALIDATION_ERROR');
  });

  it('M5-03 the factory refuses any mode but baseline', () => {
    expect(() => baselinePrivacyPort('proposed')).toThrow();
  });
});
