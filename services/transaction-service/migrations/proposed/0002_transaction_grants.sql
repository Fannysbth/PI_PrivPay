-- Least privilege, enforced by the database and tested with the real roles (NFR-09). The application never connects as
-- the schema owner, has no DELETE, and can only read the merchants.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_transaction_app;

REVOKE ALL ON merchants, transactions FROM PUBLIC, privpay_transaction_app;
GRANT SELECT ON merchants TO privpay_transaction_app;
GRANT SELECT, INSERT, UPDATE ON transactions TO privpay_transaction_app;
