-- Least privilege, enforced by the database and tested with the real roles (NFR-09). The assessments are append-only:
-- the application may add and read them, never change or remove one, and it can only read the rule table.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_fraud_app;

REVOKE ALL ON fraud_assessments, risk_rules FROM PUBLIC, privpay_fraud_app;
GRANT SELECT, INSERT ON fraud_assessments TO privpay_fraud_app;
GRANT SELECT ON risk_rules TO privpay_fraud_app;
