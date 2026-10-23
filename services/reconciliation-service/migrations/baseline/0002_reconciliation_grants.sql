-- Baseline, same as proposed. Least privilege, enforced by the database and tested with the real roles (NFR-09). Batches and items are written by
-- the report and by the run (UPDATE of the matched flags), never deleted; an audit request is only ever added, and the
-- application cannot read one back.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_reconciliation_app;

REVOKE ALL ON settlement_batches, settlement_items, audit_requests FROM PUBLIC, privpay_reconciliation_app;
GRANT SELECT, INSERT, UPDATE ON settlement_batches TO privpay_reconciliation_app;
GRANT SELECT, INSERT, UPDATE ON settlement_items TO privpay_reconciliation_app;
GRANT INSERT ON audit_requests TO privpay_reconciliation_app;
