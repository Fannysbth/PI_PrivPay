import type { SubjectSql } from '../notification/contacts';

/** ADR-0006, the proposed mode: the contact is keyed by the domain token. */
// Every value is a bind parameter (CLAUDE.md); the column names are fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  upsert: `INSERT INTO contact_registry (pseudonym, phone, channel, registered_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pseudonym) DO UPDATE SET phone = EXCLUDED.phone, channel = EXCLUDED.channel
     RETURNING (xmax = 0) AS created, registered_at`,
  phone: 'SELECT phone FROM contact_registry WHERE pseudonym = $1',
  log: `INSERT INTO notification_log (sender_pseudonym, recipient_pseudonym, template, channel, sent_at, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
};
