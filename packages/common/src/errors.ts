/**
 * One error shape for every service (NFR-25) and the eight codes an external client may see (ADR-0008).
 * Between services the detailed `reason` is kept; towards clients it is dropped (NFR-10).
 */

/** What an external client sees for each code: HTTP status and a message that never carries values. */
const CLIENTS = {
  UNAUTHENTICATED: { status: 401, message: 'Tidak terautentikasi' },
  ACCESS_DENIED: { status: 403, message: 'Akses ditolak' },
  VALIDATION_ERROR: { status: 422, message: 'Permintaan tidak valid' },
  RATE_LIMITED: { status: 429, message: 'Terlalu banyak permintaan' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Layanan tidak tersedia' },
  INTERNAL_ERROR: { status: 500, message: 'Terjadi kesalahan' },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'Kunci idempotensi bertentangan dengan permintaan sebelumnya',
  },
  NOT_HELD: { status: 409, message: 'Transaksi tidak berstatus ditahan' },
} as const;

export type ClientCode = keyof typeof CLIENTS;
export const CLIENT_CODES = Object.keys(CLIENTS) as ClientCode[];

interface ReasonInfo {
  /** HTTP status between services. */
  readonly wireStatus: number;
  readonly code: ClientCode;
}

const denied = (wireStatus: number): ReasonInfo => ({ wireStatus, code: 'ACCESS_DENIED' });
const invalid = (wireStatus: number): ReasonInfo => ({ wireStatus, code: 'VALIDATION_ERROR' });

/** platform-dan-ci.md section 4: every reason, its inter-service status, and the code clients see. */
export const REASONS = {
  TOKEN_NOT_FOUND: denied(404),
  SERVICE_MISMATCH: denied(403),
  PURPOSE_MISMATCH: denied(403),
  EXPIRED: denied(410),
  REVOKED: denied(403),
  POLICY_NOT_ALLOWED: denied(403),
  FORBIDDEN_ROLE: denied(403),
  TX_TERMINAL: denied(409),
  DISCLOSURE_NOT_FOUND: denied(404),
  DISCLOSURE_NOT_APPROVED: denied(403),
  DISCLOSURE_EXPIRED: denied(410),
  REQUESTER_MISMATCH: denied(403),
  SELF_APPROVAL: denied(403),
  DISCLOSURE_NOT_PENDING: denied(409),
  TRANSACTION_NOT_FOUND: denied(404),
  INVALID_BASIS: invalid(422),
  ATTRIBUTE_NOT_ALLOWED: invalid(422),
  VALIDATION_ERROR: invalid(422),
  IDEMPOTENCY_CONFLICT: { wireStatus: 409, code: 'IDEMPOTENCY_CONFLICT' },
  NOT_HELD: { wireStatus: 409, code: 'NOT_HELD' },
  UNAUTHENTICATED: { wireStatus: 401, code: 'UNAUTHENTICATED' },
  RATE_LIMITED: { wireStatus: 429, code: 'RATE_LIMITED' },
  SERVICE_UNAVAILABLE: { wireStatus: 503, code: 'SERVICE_UNAVAILABLE' },
  INTERNAL_ERROR: { wireStatus: 500, code: 'INTERNAL_ERROR' },
} as const satisfies Record<string, ReasonInfo>;
export type Reason = keyof typeof REASONS;

export function isReason(value: unknown): value is Reason {
  return typeof value === 'string' && Object.hasOwn(REASONS, value);
}

export class DomainError extends Error {
  readonly reason: Reason;

  constructor(reason: Reason) {
    super(reason);
    this.name = 'DomainError';
    this.reason = reason;
  }
}

export interface ErrorBody {
  readonly code: ClientCode;
  readonly reason?: Reason;
  readonly message: string;
  readonly request_id: string;
}

export interface ErrorResponse {
  readonly status: number;
  readonly body: { readonly error: ErrorBody };
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request id is echoed back, so anything that is not a UUID is replaced rather than reflected. */
function safeRequestId(requestId: string): string {
  return REQUEST_ID.test(requestId) ? requestId : '[INVALID]';
}

/** Anything that is not a DomainError with a known reason is unexpected: a generic 500, its text never forwarded. */
function reasonOf(error: unknown): Reason {
  return error instanceof DomainError && isReason(error.reason) ? error.reason : 'INTERNAL_ERROR';
}

/** Response between services: carries the detailed reason. */
export function toWireError(error: unknown, requestId: string): ErrorResponse {
  const reason = reasonOf(error);
  const { wireStatus, code } = REASONS[reason];
  return {
    status: wireStatus,
    body: {
      error: { code, reason, message: CLIENTS[code].message, request_id: safeRequestId(requestId) },
    },
  };
}

/** Response for an external client: only the eight codes, never the reason. */
export function toClientError(error: unknown, requestId: string): ErrorResponse {
  const { code } = REASONS[reasonOf(error)];
  const { status, message } = CLIENTS[code];
  return { status, body: { error: { code, message, request_id: safeRequestId(requestId) } } };
}
