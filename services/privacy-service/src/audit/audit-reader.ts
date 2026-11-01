import { DomainError } from '@privpay/common';
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

/** Filters of GET /audit-log (spec privacy 4.8), all optional and all applied together. `from` is inclusive, `to` exclusive. */
export interface AuditListFilter {
  readonly service?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly pseudonym?: string;
  readonly transactionId?: string;
  readonly action?: string;
  readonly disclosureId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AuditPaging {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface AuditPage {
  readonly items: readonly AuditRow[];
  /** Opaque; null on the last page. */
  readonly nextCursor: string | null;
}

export interface AuditRange {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface AuditSummary {
  readonly total: number;
  readonly denied: readonly { reason: string; count: number }[];
  readonly alerts: readonly {
    requestingService: string;
    reason: string;
    count: number;
    windowStart: Date;
  }[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Spec privacy 4.8 (FR-14, S-55): the page of the endpoints. */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

const ROW_COLUMNS = `id, created_at, action, status, reason, requesting_service, actor_id, pseudonym, purpose,
       transaction_id, mapping_id, disclosure_id, attribute_names, key_version,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_at`;

/**
 * Every value is a bind parameter (project rules); the only interpolated text is the constant column list above. The cursor
 * compares (created_at, id) as a pair, and `exact_at` carries the microseconds a JavaScript Date drops, so a page
 * boundary never skips or repeats a row.
 */
export const AUDIT_READ_SQL = {
  list: `SELECT ${ROW_COLUMNS} FROM audit_log
      WHERE ($1::text IS NULL OR requesting_service = $1)
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR reason = $3)
        AND ($4::text IS NULL OR pseudonym = $4)
        AND ($5::text IS NULL OR transaction_id = $5)
        AND ($6::text IS NULL OR action = $6)
        AND ($7::uuid IS NULL OR disclosure_id = $7)
        AND ($8::timestamptz IS NULL OR created_at >= $8)
        AND ($9::timestamptz IS NULL OR created_at < $9)
        AND ($10::timestamptz IS NULL OR (created_at, id) < ($10::timestamptz, $11::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $12`,
  timeline: `SELECT ${ROW_COLUMNS} FROM audit_log
      WHERE pseudonym = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at ASC, id ASC
      LIMIT $4`,
  total: `SELECT count(*) AS n FROM audit_log
      WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)`,
  denied: `SELECT reason, count(*) AS n FROM audit_log
      WHERE status = 'DENIED'
        AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)
      GROUP BY reason ORDER BY n DESC, reason`,
  // The simple alert (PRD 12, "Peringatan sederhana", mitigation of Q-11): three DENIED rows, SERVICE_MISMATCH or
  // TOKEN_NOT_FOUND (together, the PRD does not separate them), from one service within five minutes. The window ends at
  // each row and includes its five-minute boundary; `reason` is that of the row that completes the window.
  alerts: `WITH watched AS (
       SELECT requesting_service, reason, created_at, count(*) OVER w AS n, min(created_at) OVER w AS window_start
         FROM audit_log
        WHERE status = 'DENIED' AND reason IN ('SERVICE_MISMATCH', 'TOKEN_NOT_FOUND')
          AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)
       WINDOW w AS (PARTITION BY requesting_service ORDER BY created_at
                    RANGE BETWEEN INTERVAL '5 minutes' PRECEDING AND CURRENT ROW))
     SELECT DISTINCT ON (requesting_service) requesting_service, reason, n, window_start
       FROM watched WHERE n >= 3
      ORDER BY requesting_service, n DESC, created_at`,
} as const;

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');

function pageSize(limit: number | undefined): number {
  const size = limit ?? PAGE_DEFAULT;
  if (!Number.isInteger(size) || size < 1 || size > PAGE_MAX) throw invalid();
  return size;
}

/** A cursor is only ever one this reader made: anything else is a malformed request, not a database error. */
function openCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const { t, i } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
    t?: unknown;
    i?: unknown;
  };
  if (typeof t !== 'string' || typeof i !== 'string' || !CURSOR_TIME.test(t) || !UUID.test(i)) {
    throw invalid();
  }
  return { at: t, id: i };
}

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
  exact_at?: string;
}

const toRow = (r: Row): AuditRow => ({
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
});

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
    return rows.map(toRow);
  }

  /** GET /audit-log: newest first; one row more than the page is read to know whether another page follows. */
  async list(filter: AuditListFilter): Promise<AuditPage> {
    const size = pageSize(filter.limit);
    const after = openCursor(filter.cursor);
    const { rows } = await this.auditor.query<Row>(AUDIT_READ_SQL.list, [
      filter.service ?? null,
      filter.status ?? null,
      filter.reason ?? null,
      filter.pseudonym ?? null,
      filter.transactionId ?? null,
      filter.action ?? null,
      filter.disclosureId ?? null,
      filter.from ?? null,
      filter.to ?? null,
      after?.at ?? null,
      after?.id ?? null,
      size + 1,
    ]);
    return this.page(rows, size);
  }

  /** GET /audit-log/timeline/{pseudonym}: the history of one token, oldest first. */
  async timeline(pseudonym: string, paging: AuditPaging): Promise<AuditPage> {
    const size = pageSize(paging.limit);
    const after = openCursor(paging.cursor);
    const { rows } = await this.auditor.query<Row>(AUDIT_READ_SQL.timeline, [
      pseudonym,
      after?.at ?? null,
      after?.id ?? null,
      size + 1,
    ]);
    return this.page(rows, size);
  }

  /** GET /audit-log/summary (spec privacy 4.8). */
  async summary(range: AuditRange): Promise<AuditSummary> {
    const bounds = [range.from ?? null, range.to ?? null];
    // One snapshot on one connection, so the total, the counts and the alerts describe the same rows.
    const client = await this.auditor.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const total = await client.query<{ n: string }>(AUDIT_READ_SQL.total, bounds);
      const denied = await client.query<{ reason: string; n: string }>(
        AUDIT_READ_SQL.denied,
        bounds,
      );
      const alerts = await client.query<{
        requesting_service: string;
        reason: string;
        n: string;
        window_start: Date;
      }>(AUDIT_READ_SQL.alerts, bounds);
      await client.query('COMMIT');
      return {
        total: Number(total.rows[0]?.n),
        denied: denied.rows.map((row) => ({ reason: row.reason, count: Number(row.n) })),
        alerts: alerts.rows.map((row) => ({
          requestingService: row.requesting_service,
          reason: row.reason,
          count: Number(row.n),
          windowStart: row.window_start,
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private page(rows: Row[], size: number): AuditPage {
    const shown = rows.slice(0, size);
    const last = shown[shown.length - 1];
    const more = rows.length > size && last?.exact_at !== undefined;
    return {
      items: shown.map(toRow),
      nextCursor: more
        ? Buffer.from(JSON.stringify({ t: last.exact_at, i: last.id })).toString('base64url')
        : null,
    };
  }
}
