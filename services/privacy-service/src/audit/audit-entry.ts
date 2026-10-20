import type { Reason } from '@privpay/common';

// Catalogue of spec privacy 9.1 (E-05). A new action needs a spec change, so it needs a change here.
export const AUDIT_ACTIONS = [
  'GENERATE_TOKEN',
  'EXCHANGE_TOKEN',
  'RESOLVE_NOTIF_DOMAIN',
  'DE_PSEUDONYMIZE',
  'RE_ISSUE',
  'REVOKE_TOKEN',
  'REVOKE_SUBJECT',
  'PURGE_IDENTITY',
  'STORE_IDENTITY',
  'VIEW_AUDIT_LOG',
  'DISCLOSURE_REQUESTED',
  'DISCLOSURE_APPROVED',
  'DISCLOSURE_REJECTED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditStatus = 'SUCCESS' | 'DENIED';

/** Names only, never values (FR-15); the same list as chk_attribute_names. */
export type AuditAttributeName = 'customer_id' | 'nik' | 'nama';

/**
 * What one audit row may say (spec privacy 9.2). There is no field for a subject, an identity value or free text:
 * `reason` is a fixed code, so nothing can be smuggled into it (invariant 6).
 */
export interface AuditEntry {
  readonly action: AuditAction;
  readonly status: AuditStatus;
  readonly reason: Reason | 'OK';
  readonly requestingService: string;
  readonly actorId?: string;
  readonly pseudonym?: string;
  readonly purpose?: string;
  readonly transactionId?: string;
  readonly mappingId?: string;
  readonly disclosureId?: string;
  readonly attributeNames?: readonly AuditAttributeName[];
  readonly keyVersion?: number;
}

/** Names the field only: the value is what must never reach a log, an error or a row (FR-15). */
export class AuditEntryError extends RangeError {
  readonly field: string;

  constructor(field: string) {
    super(`audit entry field ${field} has an invalid format`);
    this.name = 'AuditEntryError';
    this.field = field;
  }
}

// Formats of platform-dan-ci.md 3.1 (`Pseudonym`, `TransactionId`); `purpose` is an upper-case identifier that fits
// VARCHAR(48); `actorId` is a subject id or SYSTEM: no '@', '.' or space (so no e-mail or name) and never all digits
// (so no NIK-like number). A format cannot prove a value is not personal, it removes the easy channels.
const FORMATS = {
  pseudonym: /^PSEU-[0-9A-F]{8}$/,
  transactionId: /^TX-[0-9]{1,29}$/,
  purpose: /^[A-Z][A-Z0-9_]{0,47}$/,
  actorId: /^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
} as const;

/** Refuses a malformed entry before anything is sent to the database (spec privacy 9.2). */
export function assertAuditEntry(entry: AuditEntry): void {
  for (const field of Object.keys(FORMATS) as (keyof typeof FORMATS)[]) {
    const value: unknown = entry[field];
    if (value !== undefined && (typeof value !== 'string' || !FORMATS[field].test(value))) {
      throw new AuditEntryError(field);
    }
  }
}
