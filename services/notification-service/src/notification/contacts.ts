import type { Pool } from 'pg';

export type SendStatus = 'SENT' | 'FAILED';

export interface LogEntry {
  readonly sender: string;
  readonly recipient: string;
  readonly template: string;
  readonly channel: string;
  readonly status: SendStatus;
  readonly sentAt: Date;
}

/** Every value is a bind parameter (CLAUDE.md). */
export const CONTACT_SQL = {
  // Registration is an upsert keyed by the domain token (spec notification 3.1, ADR-0005): a repeat changes the phone and
  // keeps the moment of the first registration. `xmax = 0` is true only for a row that this statement inserted.
  upsert: `INSERT INTO contact_registry (pseudonym, phone, channel, registered_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pseudonym) DO UPDATE SET phone = EXCLUDED.phone, channel = EXCLUDED.channel
     RETURNING (xmax = 0) AS created, registered_at`,
  phone: 'SELECT phone FROM contact_registry WHERE pseudonym = $1',
  // No column for the text of the message (spec notification 3.2): it holds an amount and could become a profile.
  log: `INSERT INTO notification_log (sender_pseudonym, recipient_pseudonym, template, channel, sent_at, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
} as const;

/** The proposed adapter of the repository seam: the key is the domain token. The baseline one, by customer, is M5-01. */
export class ContactRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async upsert(
    pseudonym: string,
    phone: string,
    channel: string,
    at: Date,
  ): Promise<{ created: boolean; registeredAt: Date }> {
    const result = await this.pool.query<{ created: boolean; registered_at: Date }>(
      CONTACT_SQL.upsert,
      [pseudonym, phone, channel, at],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the upsert of a contact returned no row');
    return { created: row.created, registeredAt: row.registered_at };
  }

  async phoneOf(pseudonym: string): Promise<string | undefined> {
    const result = await this.pool.query<{ phone: string }>(CONTACT_SQL.phone, [pseudonym]);
    return result.rows[0]?.phone;
  }

  async log(entry: LogEntry): Promise<void> {
    await this.pool.query(CONTACT_SQL.log, [
      entry.sender,
      entry.recipient,
      entry.template,
      entry.channel,
      entry.sentAt,
      entry.status,
    ]);
  }
}
