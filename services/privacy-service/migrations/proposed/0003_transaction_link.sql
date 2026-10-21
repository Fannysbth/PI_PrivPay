-- K-28, ADR-0013: which token was issued or reused for which transaction id, per context. The mapping row keeps
-- only the first transaction id of a reused token, so form 3 (generate_from_transaction) could not find the source of
-- a second transaction inside the same TTL. No identity column: only the key, the token and the time.
CREATE TABLE transaction_link (
  transaction_id  VARCHAR(32)       NOT NULL,
  subject_type    subject_type_enum NOT NULL,
  service_id      VARCHAR(32)       NOT NULL,
  purpose         VARCHAR(48)       NOT NULL,
  pseudonym       VARCHAR(16)       NOT NULL REFERENCES pseudonym_mapping (pseudonym),
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT now(),
  -- One token per transaction in each context (P1 and P2 differ by subject type, the exchanged tokens by service and
  -- purpose): the same transaction id with another token is a conflict, not a second link.
  PRIMARY KEY (transaction_id, subject_type, service_id, purpose)
);
CREATE INDEX idx_link_pseudonym ON transaction_link (pseudonym);

-- Unlike every other table the application may delete here: retention removes a link together with the identity of
-- its row (ADR-0013). The auditor has no access.
REVOKE ALL ON transaction_link FROM PUBLIC, privpay_app, privpay_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON transaction_link TO privpay_app;
