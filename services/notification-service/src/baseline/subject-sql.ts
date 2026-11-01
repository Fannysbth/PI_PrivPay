import type { SubjectSql } from '../notification/contacts';

/** ADR-0006, the baseline mode: the contact is keyed by the customer_id itself (spec data 9, N-42). */
// Every value is a bind parameter (project rules); the column names are fixed text, never input.
export const SUBJECT_SQL: SubjectSql = {
  upsert: `INSERT INTO contact_registry (customer_id, phone, channel, registered_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (customer_id) DO UPDATE SET phone = EXCLUDED.phone, channel = EXCLUDED.channel
     RETURNING (xmax = 0) AS created, registered_at`,
  phone: 'SELECT phone FROM contact_registry WHERE customer_id = $1',
  log: `INSERT INTO notification_log (sender_customer_id, recipient_customer_id, template, channel, sent_at, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
};
