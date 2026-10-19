import { CLIENT_CODES, DomainError, REASONS, type Reason } from '@privpay/common';
import { ErrorMasker } from '../src/error-masker';

const ID_A = '0b9f3c8e-6a52-4a53-9f43-1f7b3d1f6a10';
const ID_B = '6c0f1b1e-3f55-4c9c-8d27-9a0a6a2b8e44';
const masker = new ErrorMasker();
const reasons = Object.keys(REASONS) as Reason[];

describe('M1-03 ErrorMasker.toClient turns every inter-service reason into one of the eight codes (NFR-10, NFR-25)', () => {
  it.each(reasons)(
    'M1-03 TK-12 %s becomes one of the eight codes and the reason is not sent',
    (reason) => {
      const { status, body } = masker.toClient(new DomainError(reason), ID_A);
      expect(CLIENT_CODES).toContain(body.error.code);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
      expect(body.error).not.toHaveProperty('reason');
      expect(status).toBe(masker.toClient(new DomainError(reason), ID_B).status);
    },
  );

  it('M1-03 TK-12 a token that exists and one that does not give the same answer except request_id', () => {
    // Privacy answers TOKEN_NOT_FOUND for an unknown token and SERVICE_MISMATCH / PURPOSE_MISMATCH / REVOKED / EXPIRED
    // for known ones: the client must not be able to tell them apart (NFR-10).
    const answers = (
      [
        'TOKEN_NOT_FOUND',
        'SERVICE_MISMATCH',
        'PURPOSE_MISMATCH',
        'REVOKED',
        'EXPIRED',
        'POLICY_NOT_ALLOWED',
      ] as const
    ).map((reason) => JSON.stringify(masker.toClient(new DomainError(reason), ID_A)));
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] ?? '{}')).toMatchObject({
      status: 403,
      body: { error: { code: 'ACCESS_DENIED' } },
    });
  });

  it('M1-03 anything that is not a DomainError, or has a reason nobody knows, is a plain 500 with no text', () => {
    for (const error of [
      new Error('SELECT * FROM identity_vault'),
      'text',
      null,
      undefined,
      { reason: 'TOKEN_NOT_FOUND' },
    ]) {
      const { status, body } = masker.toClient(error, ID_A);
      expect(status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(body)).not.toContain('SELECT');
    }
  });

  it('M1-03 the request id of the answer is the one given, and a foreign one is replaced', () => {
    expect(masker.toClient(new DomainError('EXPIRED'), ID_A).body.error.request_id).toBe(ID_A);
    expect(
      masker.toClient(new DomainError('EXPIRED'), 'PSEU-AB12CD34<script>').body.error.request_id,
    ).toBe('[INVALID]');
  });
});

describe('M1-03 ErrorMasker.fromDownstream reads what a service answered with, and trusts none of it blindly', () => {
  it('M1-03 a downstream error body with a known reason becomes that reason', () => {
    const error = masker.fromDownstream(403, {
      error: { code: 'ACCESS_DENIED', reason: 'SERVICE_MISMATCH', message: 'x', request_id: ID_A },
    });
    expect(error).toBeInstanceOf(DomainError);
    expect(error.reason).toBe('SERVICE_MISMATCH');
  });

  it.each([
    ['an unknown reason', { error: { reason: 'MADE_UP' } }],
    ['no reason', { error: { code: 'ACCESS_DENIED' } }],
    ['no error object', { message: 'boom' }],
    ['text', 'Internal Server Error'],
    ['null', null],
    ['a reason that is not text', { error: { reason: 42 } }],
    ['a prototype key', { error: { reason: '__proto__' } }],
    ['a reason that inherits from Object', { error: { reason: 'toString' } }],
  ])('M1-03 %s becomes INTERNAL_ERROR', (_name, body) => {
    expect(masker.fromDownstream(500, body).reason).toBe('INTERNAL_ERROR');
  });

  it('M1-03 the downstream status decides when the body gives no reason: 401, 503, 429', () => {
    expect(masker.fromDownstream(401, null).reason).toBe('UNAUTHENTICATED');
    expect(masker.fromDownstream(503, null).reason).toBe('SERVICE_UNAVAILABLE');
    expect(masker.fromDownstream(429, null).reason).toBe('RATE_LIMITED');
  });

  it('M1-03 what the downstream wrote in its message never reaches the client', () => {
    const error = masker.fromDownstream(403, {
      error: { reason: 'TOKEN_NOT_FOUND', message: 'token PSEU-AB12CD34 not found for fake-name' },
    });
    const { body } = masker.toClient(error, ID_A);
    expect(JSON.stringify(body)).not.toContain('PSEU-AB12CD34');
    expect(JSON.stringify(body)).not.toContain('fake-name');
  });
});
