-- Least privilege, enforced by the database and tested with the real roles (TK-10, S-34, S-35, NFR-09).
-- The application never connects as the schema owner and has no DELETE on any table.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_app, privpay_auditor;

-- Append-only audit log: the application may only add rows and cannot read them back, the auditor may only read.
REVOKE ALL ON audit_log FROM PUBLIC, privpay_app, privpay_auditor;
GRANT INSERT ON audit_log TO privpay_app;
GRANT SELECT ON audit_log TO privpay_auditor;

REVOKE ALL ON pseudonym_mapping, transaction_status, identity_vault, disclosure_request
  FROM PUBLIC, privpay_app, privpay_auditor;
GRANT SELECT, INSERT, UPDATE ON pseudonym_mapping, transaction_status, identity_vault, disclosure_request
  TO privpay_app;
