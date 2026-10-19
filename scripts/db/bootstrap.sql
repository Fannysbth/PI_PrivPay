-- PrivPay local bootstrap (ADR-0004). Run via scripts/db/bootstrap.ps1, never by hand with passwords on the CLI.
-- Creates one database and an owner/runtime role pair per service (privacy also gets a read-only audit role) plus
-- the test admin. Touches ONLY objects named privpay_*. No superuser is created; no other database is modified.
-- Idempotent: safe to run again (it also re-syncs the role passwords with the secrets files).
-- Note: if the server runs with log_statement = 'ddl'/'all' (or 'mod'), ALTER ROLE ... PASSWORD is logged in clear
-- text. This is a local dev server; keep log_statement at its default ('none').
\set ON_ERROR_STOP on
\set ECHO none
\set QUIET on

\getenv pw_privacy_owner PRIVPAY_PW_PRIVACY_OWNER
\getenv pw_app PRIVPAY_PW_APP
\getenv pw_auditor PRIVPAY_PW_AUDITOR
\getenv pw_test_admin PRIVPAY_PW_TEST_ADMIN
\getenv pw_transaction_owner PRIVPAY_PW_TRANSACTION_OWNER
\getenv pw_transaction_app PRIVPAY_PW_TRANSACTION_APP
\getenv pw_fraud_owner PRIVPAY_PW_FRAUD_OWNER
\getenv pw_fraud_app PRIVPAY_PW_FRAUD_APP
\getenv pw_notification_owner PRIVPAY_PW_NOTIFICATION_OWNER
\getenv pw_notification_app PRIVPAY_PW_NOTIFICATION_APP
\getenv pw_reconciliation_owner PRIVPAY_PW_RECONCILIATION_OWNER
\getenv pw_reconciliation_app PRIVPAY_PW_RECONCILIATION_APP

SELECT :{?pw_privacy_owner} AND :{?pw_app} AND :{?pw_auditor} AND :{?pw_test_admin}
   AND :{?pw_transaction_owner} AND :{?pw_transaction_app}
   AND :{?pw_fraud_owner} AND :{?pw_fraud_app}
   AND :{?pw_notification_owner} AND :{?pw_notification_app}
   AND :{?pw_reconciliation_owner} AND :{?pw_reconciliation_app} AS all_passwords \gset
\if :all_passwords
\else
  DO $$ BEGIN RAISE EXCEPTION 'one or more PRIVPAY_PW_* variables are missing'; END $$;
\endif

-- Roles: LOGIN, never superuser / createrole. Only the test admin may create databases (to recreate test DBs).
CREATE TEMP TABLE _privpay_roles (name text PRIMARY KEY, pw text NOT NULL, extra text NOT NULL);
INSERT INTO _privpay_roles VALUES
  ('privpay_privacy_owner',         :'pw_privacy_owner',         'NOCREATEDB'),
  ('privpay_app',                   :'pw_app',                   'NOCREATEDB'),
  ('privpay_auditor',               :'pw_auditor',               'NOCREATEDB'),
  ('privpay_transaction_owner',     :'pw_transaction_owner',     'NOCREATEDB'),
  ('privpay_transaction_app',       :'pw_transaction_app',       'NOCREATEDB'),
  ('privpay_fraud_owner',           :'pw_fraud_owner',           'NOCREATEDB'),
  ('privpay_fraud_app',             :'pw_fraud_app',             'NOCREATEDB'),
  ('privpay_notification_owner',    :'pw_notification_owner',    'NOCREATEDB'),
  ('privpay_notification_app',      :'pw_notification_app',      'NOCREATEDB'),
  ('privpay_reconciliation_owner',  :'pw_reconciliation_owner',  'NOCREATEDB'),
  ('privpay_reconciliation_app',    :'pw_reconciliation_app',    'NOCREATEDB'),
  ('privpay_test_admin',            :'pw_test_admin',            'CREATEDB');

CREATE TEMP TABLE _privpay_services (db text PRIMARY KEY, owner text NOT NULL, app text NOT NULL, auditor text);
INSERT INTO _privpay_services VALUES
  ('privpay_privacy',        'privpay_privacy_owner',        'privpay_app',                  'privpay_auditor'),
  ('privpay_transaction',    'privpay_transaction_owner',    'privpay_transaction_app',      NULL),
  ('privpay_fraud',          'privpay_fraud_owner',          'privpay_fraud_app',            NULL),
  ('privpay_notification',   'privpay_notification_owner',   'privpay_notification_app',     NULL),
  ('privpay_reconciliation', 'privpay_reconciliation_owner', 'privpay_reconciliation_app',   NULL);

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION %s', name, extra)
  FROM _privpay_roles r
 WHERE name LIKE 'privpay\_%'
   AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name)
\gexec

-- Only the password is re-synced: attributes are fixed at creation, because a non-superuser admin (CREATEROLE) may not
-- re-state the SUPERUSER attribute even to the same value. The integration tests check the attributes.
SELECT format('ALTER ROLE %I WITH PASSWORD %L', name, pw)
  FROM _privpay_roles
 WHERE name LIKE 'privpay\_%'
\gexec

-- The test admin recreates test databases owned by each schema owner, so it must be able to SET ROLE to them.
SELECT format('GRANT %I TO privpay_test_admin', owner) FROM _privpay_services \gexec

-- The connecting admin must be able to SET ROLE to the owner roles to create databases owned by them and to run the
-- schema grants below (unless superuser). The membership is temporary: it is revoked at the end of this script,
-- also when an earlier run left it behind (the owner roles are created by this project, so the admin has no other
-- reason to be a member). If the script fails between the GRANT and the final REVOKE, the membership stays:
-- run the script again (it is idempotent) or run REVOKE <owner role> FROM <admin> by hand.
SELECT NOT rolsuper AS needs_membership FROM pg_roles WHERE rolname = current_user \gset
\if :needs_membership
  SELECT format('GRANT %I TO CURRENT_USER', owner) FROM _privpay_services \gexec
\endif

SELECT format('CREATE DATABASE %I OWNER %I', db, owner)
  FROM _privpay_services s
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = s.db)
\gexec

-- Only the service's own roles may connect to its database (invariant 4).
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db) FROM _privpay_services \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', db, app) FROM _privpay_services \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', db, auditor) FROM _privpay_services WHERE auditor IS NOT NULL \gexec

-- Per database: nobody but the owner may create objects in the public schema; runtime roles only get USAGE.
\c privpay_privacy
SET ROLE privpay_privacy_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_app, privpay_auditor;
RESET ROLE;

\c privpay_transaction
SET ROLE privpay_transaction_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_transaction_app;
RESET ROLE;

\c privpay_fraud
SET ROLE privpay_fraud_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_fraud_app;
RESET ROLE;

\c privpay_notification
SET ROLE privpay_notification_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_notification_app;
RESET ROLE;

\c privpay_reconciliation
SET ROLE privpay_reconciliation_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_reconciliation_app;
RESET ROLE;

\if :needs_membership
  REVOKE privpay_privacy_owner FROM CURRENT_USER;
  REVOKE privpay_transaction_owner FROM CURRENT_USER;
  REVOKE privpay_fraud_owner FROM CURRENT_USER;
  REVOKE privpay_notification_owner FROM CURRENT_USER;
  REVOKE privpay_reconciliation_owner FROM CURRENT_USER;
\endif

\set QUIET off
\echo 'privpay bootstrap done: databases privpay_privacy, privpay_transaction, privpay_fraud, privpay_notification, privpay_reconciliation; owner and runtime roles per service, privpay_auditor, privpay_test_admin'
SELECT CASE
         WHEN rolsuper THEN 'admin is a superuser: no membership change was made'
         WHEN pg_has_role(current_user, 'privpay_privacy_owner', 'SET')
           OR pg_has_role(current_user, 'privpay_transaction_owner', 'SET')
           OR pg_has_role(current_user, 'privpay_fraud_owner', 'SET')
           OR pg_has_role(current_user, 'privpay_notification_owner', 'SET')
           OR pg_has_role(current_user, 'privpay_reconciliation_owner', 'SET')
           THEN 'WARNING: admin can still SET ROLE to a privpay_*_owner role'
         ELSE 'admin membership in the privpay_*_owner roles revoked'
       END AS admin_membership
  FROM pg_roles WHERE rolname = current_user;
