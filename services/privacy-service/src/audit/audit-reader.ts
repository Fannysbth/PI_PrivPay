import type { Pool } from 'pg';
import type { AuditAction, AuditAttributeName, AuditStatus } from './audit-entry';

export interface AuditFilter {
  readonly action?: AuditAction;
  readonly status?: AuditStatus;
  readonly pseudonym?: string;
  readonly limit?: number;
}

export interface AuditRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly action: string;
  readonly status: string;
  readonly reason: string;
  readonly requestingService: string;
  readonly actorId: string | null;
  readonly pseudonym: string | null;
  readonly purpose: string | null;
  readonly transactionId: string | null;
  readonly mappingId: string | null;
  readonly disclosureId: string | null;
  readonly attributeNames: readonly AuditAttributeName[] | null;
  readonly keyVersion: number | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface Row {
  id: string;
  created_at: Date;
  action: string;
  status: string;
  reason: string;
  requesting_service: string;
  actor_id: string | null;
  pseudonym: string | null;
  purpose: string | null;
  transaction_id: string | null;
  mapping_id: string | null;
  disclosure_id: string | null;
  attribute_names: AuditAttributeName[] | null;
  key_version: number | null;
}

/** Reads audit_log through the pool of privpay_auditor only; the app pool has no SELECT on it (spec privacy 3). */
export class AuditReader {
  constructor(private readonly auditor: Pool) {}

  /** Newest first. Every filter is a bind parameter. */
  async query(filter: AuditFilter): Promise<AuditRow[]> {
    const limit = filter.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`limit must be an integer from 1 to ${String(MAX_LIMIT)}`);
    }
    const { rows } = await this.auditor.query<Row>(
      `SELECT id, created_at, action, status, reason, requesting_service, actor_id, pseudonym, purpose,
              transaction_id, mapping_id, disclosure_id, attribute_names, key_version
         FROM audit_log
        WHERE ($1::text IS NULL OR action = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR pseudonym = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [filter.action ?? null, filter.status ?? null, filter.pseudonym ?? null, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      action: r.action,
      status: r.status,
      reason: r.reason,
      requestingService: r.requesting_service,
      actorId: r.actor_id,
      pseudonym: r.pseudonym,
      purpose: r.purpose,
      transactionId: r.transaction_id,
      mappingId: r.mapping_id,
      disclosureId: r.disclosure_id,
      attributeNames: r.attribute_names,
      keyVersion: r.key_version,
    }));
  }
}
