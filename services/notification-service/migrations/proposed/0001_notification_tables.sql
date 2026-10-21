-- notification-db, mode proposed: PRD 11. `phone` is the only personal value outside Privacy and the IdP (D-08, E(s)
-- of Notification is 1/6). There is no column for the text of a message: it holds an amount and could become a profile.

CREATE TABLE contact_registry (
  pseudonym     VARCHAR(16) PRIMARY KEY,
  phone         VARCHAR(20) NOT NULL,
  channel       VARCHAR(16) NOT NULL DEFAULT 'SMS',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_contact_channel CHECK (channel IN ('SMS'))
);

CREATE TABLE notification_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_pseudonym     VARCHAR(16) NOT NULL,
  recipient_pseudonym  VARCHAR(16) NOT NULL,
  template             VARCHAR(32) NOT NULL,
  channel              VARCHAR(16) NOT NULL,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               VARCHAR(16) NOT NULL
);
