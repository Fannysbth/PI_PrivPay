import type { Pool } from 'pg';

export type SendStatus = 'SENT' | 'FAILED';

/** G4: what the edge handed over beside the reference; kept by a mode whose table has the columns (G6), never sent. */
export interface ClientAttributes {
  readonly nik?: string;
  readonly nama?: string;
  readonly accountNumber?: string;
}

export interface LogEntry {
  readonly sender: string;
  readonly recipient: string;
  readonly template: string;
  readonly channel: string;
  readonly status: SendStatus;
  readonly sentAt: Date;
}

/**
 * ADR-0006: the three statements that name the columns of the subject, the only SQL that differs between the modes.
 * The folder of each mode (`proposed/`, `baseline/`) supplies them; the repository below is one code for both.
 */
export interface SubjectSql {
  // G6: true when `upsert` has three more parameters, `$5` (nik), `$6` (nama) and `$7` (account number). pg refuses a
  // statement bound to more values than it names, so they are bound only for the SQL that has the columns.
  readonly storesClientAttributes: boolean;
  // Registration is an upsert keyed by the subject (spec notification 3.1, ADR-0005): a repeat changes the phone and
  // keeps the moment of the first registration. `xmax = 0` is true only for a row that this statement inserted.
  readonly upsert: string;
  readonly phone: string;
  // No column for the text of the message (spec notification 3.2): it holds an amount and could become a profile.
  readonly log: string;
}

/**
 * The repository of the seam (ADR-0006). It knows no mode: the contact is keyed by the domain token in proposed and by
 * the `customer_id` in baseline, and the SQL that names the key is handed in by the adapter of the mode.
 */
export class ContactRepository {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly subject: SubjectSql,
  ) {}

  async upsert(
    pseudonym: string,
    phone: string,
    channel: string,
    at: Date,
    attributes?: ClientAttributes,
  ): Promise<{ created: boolean; registeredAt: Date }> {
    const result = await this.pool.query<{ created: boolean; registered_at: Date }>(
      this.subject.upsert,
      this.subject.storesClientAttributes
        ? [
            pseudonym,
            phone,
            channel,
            at,
            attributes?.nik ?? null,
            attributes?.nama ?? null,
            attributes?.accountNumber ?? null,
          ]
        : [pseudonym, phone, channel, at],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the upsert of a contact returned no row');
    return { created: row.created, registeredAt: row.registered_at };
  }

  async phoneOf(pseudonym: string): Promise<string | undefined> {
    const result = await this.pool.query<{ phone: string }>(this.subject.phone, [pseudonym]);
    return result.rows[0]?.phone;
  }

  async log(entry: LogEntry): Promise<void> {
    await this.pool.query(this.subject.log, [
      entry.sender,
      entry.recipient,
      entry.template,
      entry.channel,
      entry.sentAt,
      entry.status,
    ]);
  }
}
