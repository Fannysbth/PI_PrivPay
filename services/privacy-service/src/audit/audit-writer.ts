import type { PoolClient } from 'pg';
import type { AuditEntry } from './audit-entry';

/** The only code path that inserts into audit_log (M2-04); the connection decides which role does it. */
export class AuditWriter {
  /**
   * Adds the one row of an operation on the caller's connection, so it commits or rolls back together with the
   * operation's result (FR-13). No RETURNING: privpay_app has no SELECT on audit_log (spec privacy 3).
   */
  async record(entry: AuditEntry, tx: Pick<PoolClient, 'query'>): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log
         (action, status, reason, requesting_service, actor_id, pseudonym, purpose, transaction_id,
          mapping_id, disclosure_id, attribute_names, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12)`,
      [
        entry.action,
        entry.status,
        entry.reason,
        entry.requestingService,
        entry.actorId ?? null,
        entry.pseudonym ?? null,
        entry.purpose ?? null,
        entry.transactionId ?? null,
        entry.mappingId ?? null,
        entry.disclosureId ?? null,
        entry.attributeNames === undefined ? null : [...entry.attributeNames],
        entry.keyVersion ?? null,
      ],
    );
  }
}
