/**
 * One error shape for every service (NFR-25) and the eight codes an external client may see (ADR-0008).
 * Between services the detailed `reason` is kept; towards clients it is dropped (NFR-10).
 */
export const CLIENT_CODES = [
  'UNAUTHENTICATED',
  'ACCESS_DENIED',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'NOT_HELD',
] as const;
export type ClientCode = (typeof CLIENT_CODES)[number];

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

/** HTTP status an external client receives for each code. */
const CLIENT_STATUS: Record<ClientCode, number> = {
  UNAUTHENTICATED: 401,
  ACCESS_DENIED: 403,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  IDEMPOTENCY_CONFLICT: 409,
  NOT_HELD: 409,
};

/** Generic on purpose: messages never carry identifiers or values. */
const MESSAGES: Record<ClientCode, string> = {
  UNAUTHENTICATED: 'Tidak terautentikasi',
  ACCESS_DENIED: 'Akses ditolak',
  VALIDATION_ERROR: 'Permintaan tidak valid',
  RATE_LIMITED: 'Terlalu banyak permintaan',
  SERVICE_UNAVAILABLE: 'Layanan tidak tersedia',
  INTERNAL_ERROR: 'Terjadi kesalahan',
  IDEMPOTENCY_CONFLICT: 'Kunci idempotensi bertentangan dengan permintaan sebelumnya',
  NOT_HELD: 'Transaksi tidak berstatus ditahan',
};

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

/** Anything that is not a DomainError is unexpected: it becomes a generic 500 and its text is never forwarded. */
function reasonOf(error: unknown): Reason {
  return error instanceof DomainError ? error.reason : 'INTERNAL_ERROR';
}

/** Response between services: carries the detailed reason. */
export function toWireError(error: unknown, requestId: string): ErrorResponse {
  const reason = reasonOf(error);
  const { wireStatus, code } = REASONS[reason];
  return {
    status: wireStatus,
    body: { error: { code, reason, message: MESSAGES[code], request_id: requestId } },
  };
}

/** Response for an external client: only the eight codes, never the reason. */
export function toClientError(error: unknown, requestId: string): ErrorResponse {
  const { code } = REASONS[reasonOf(error)];
  return {
    status: CLIENT_STATUS[code],
    body: { error: { code, message: MESSAGES[code], request_id: requestId } },
  };
}
