import { CLIENT_CODES, DomainError, REASONS, toClientError, toWireError } from '../src/errors';

const CANARY_SQL = 'select nik from identity_vault where nik = 3273015501900001';

describe('M0-02 errors have one uniform shape (NFR-25) and eight client codes (ADR-0008)', () => {
  it('M0-02 exposes exactly the eight client codes', () => {
    expect([...CLIENT_CODES].sort()).toEqual(
      [
        'ACCESS_DENIED',
        'IDEMPOTENCY_CONFLICT',
        'INTERNAL_ERROR',
        'NOT_HELD',
        'RATE_LIMITED',
        'SERVICE_UNAVAILABLE',
        'UNAUTHENTICATED',
        'VALIDATION_ERROR',
      ].sort(),
    );
  });

  // reason, status between services, client code, status towards external clients (platform-dan-ci 4)
  const table: [string, number, string, number][] = [
    ['TOKEN_NOT_FOUND', 404, 'ACCESS_DENIED', 403],
    ['SERVICE_MISMATCH', 403, 'ACCESS_DENIED', 403],
    ['PURPOSE_MISMATCH', 403, 'ACCESS_DENIED', 403],
    ['EXPIRED', 410, 'ACCESS_DENIED', 403],
    ['REVOKED', 403, 'ACCESS_DENIED', 403],
    ['POLICY_NOT_ALLOWED', 403, 'ACCESS_DENIED', 403],
    ['FORBIDDEN_ROLE', 403, 'ACCESS_DENIED', 403],
    ['TX_TERMINAL', 409, 'ACCESS_DENIED', 403],
    ['DISCLOSURE_NOT_FOUND', 404, 'ACCESS_DENIED', 403],
    ['DISCLOSURE_NOT_APPROVED', 403, 'ACCESS_DENIED', 403],
    ['DISCLOSURE_EXPIRED', 410, 'ACCESS_DENIED', 403],
    ['REQUESTER_MISMATCH', 403, 'ACCESS_DENIED', 403],
    ['SELF_APPROVAL', 403, 'ACCESS_DENIED', 403],
    ['DISCLOSURE_NOT_PENDING', 409, 'ACCESS_DENIED', 403],
    ['TRANSACTION_NOT_FOUND', 404, 'ACCESS_DENIED', 403],
    ['INVALID_BASIS', 422, 'VALIDATION_ERROR', 422],
    ['ATTRIBUTE_NOT_ALLOWED', 422, 'VALIDATION_ERROR', 422],
    ['VALIDATION_ERROR', 422, 'VALIDATION_ERROR', 422],
    ['IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT', 409],
    ['NOT_HELD', 409, 'NOT_HELD', 409],
    ['UNAUTHENTICATED', 401, 'UNAUTHENTICATED', 401],
    ['RATE_LIMITED', 429, 'RATE_LIMITED', 429],
    ['SERVICE_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE', 503],
    ['INTERNAL_ERROR', 500, 'INTERNAL_ERROR', 500],
  ];

  it.each(table)(
    'M0-02 maps %s to %i between services and to %s (%i) for clients',
    (reason, wireStatus, clientCode, clientStatus) => {
      const error = new DomainError(reason as keyof typeof REASONS);
      const wire = toWireError(error, 'req-1');
      expect(wire.status).toBe(wireStatus);
      expect(wire.body.error).toMatchObject({ code: clientCode, reason, request_id: 'req-1' });
      const client = toClientError(error, 'req-1');
      expect(client.status).toBe(clientStatus);
      expect(client.body.error.code).toBe(clientCode);
    },
  );

  it('M0-02 covers every known reason in the table above', () => {
    expect(Object.keys(REASONS).sort()).toEqual(table.map(([reason]) => reason).sort());
  });

  it('M0-02 never exposes a reason to an external client (NFR-10)', () => {
    for (const [reason] of table) {
      const { body } = toClientError(new DomainError(reason as keyof typeof REASONS), 'req-1');
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
    }
  });

  it('M0-02 makes an unknown token and a token of another service indistinguishable to clients (TK-12)', () => {
    const unknown = toClientError(new DomainError('TOKEN_NOT_FOUND'), 'req-1');
    const foreign = toClientError(new DomainError('SERVICE_MISMATCH'), 'req-1');
    expect(unknown).toEqual(foreign);
  });

  it('M0-02 turns an unexpected failure into a generic 500 without leaking its message (qa E-05)', () => {
    for (const convert of [toWireError, toClientError]) {
      const response = convert(new Error(CANARY_SQL), 'req-9');
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('identity_vault');
      expect(response.body.error.request_id).toBe('req-9');
    }
  });

  it('M0-02 treats a thrown non-Error value as an unexpected failure too', () => {
    expect(toClientError('boom', 'req-2').status).toBe(500);
  });
});
