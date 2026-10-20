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
