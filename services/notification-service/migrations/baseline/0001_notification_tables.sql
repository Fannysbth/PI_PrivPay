-- notification-db, mode baseline (M5-01, FR-23, spec data 9, N-42): the schema of proposed with the pseudonym columns
-- replaced by the customer_id. It holds real identities by design, so it is only ever run when PRIVACY_MODE=baseline.
-- `phone` is personal data in both modes (D-08).
-- of Notification is 1/6). There is no column for the text of a message: it holds an amount and could become a profile.

CREATE TABLE contact_registry (
  customer_id   VARCHAR(16) PRIMARY KEY,
  phone         VARCHAR(20) NOT NULL,
  channel       VARCHAR(16) NOT NULL DEFAULT 'SMS',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_contact_channel CHECK (channel IN ('SMS'))
);

CREATE TABLE notification_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_customer_id   VARCHAR(16) NOT NULL,
  recipient_customer_id VARCHAR(16) NOT NULL,
  template             VARCHAR(32) NOT NULL,
  channel              VARCHAR(16) NOT NULL,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               VARCHAR(16) NOT NULL
);
