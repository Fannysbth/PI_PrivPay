-- Baseline, same as proposed. Least privilege, enforced by the database and tested with the real roles (NFR-09). A contact can be added, read and
-- updated (registration is an upsert) but never deleted; the log is append-only and cannot even be read back by the
-- application, since it does not need to.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_notification_app;

REVOKE ALL ON contact_registry, notification_log FROM PUBLIC, privpay_notification_app;
GRANT SELECT, INSERT, UPDATE ON contact_registry TO privpay_notification_app;
GRANT INSERT ON notification_log TO privpay_notification_app;
