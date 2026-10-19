-- PrivPay local bootstrap (ADR-0004). Run via scripts/db/bootstrap.ps1, never by hand with passwords on the CLI.
-- Touches ONLY objects named privpay_*. No superuser is created; no other database is modified.
-- Note: if the server runs with log_statement = 'ddl'/'all', ALTER ROLE ... PASSWORD is logged in clear text.
-- This is a local dev server; keep log_statement at its default ('none').
\set ON_ERROR_STOP on
\set ECHO none
\set QUIET on

\getenv pw_owner PRIVPAY_PW_PRIVACY_OWNER
\getenv pw_app PRIVPAY_PW_APP
\getenv pw_auditor PRIVPAY_PW_AUDITOR
\getenv pw_testadmin PRIVPAY_PW_TEST_ADMIN

\if :{?pw_owner}
\else
  \echo 'PRIVPAY_PW_PRIVACY_OWNER missing'
  \quit 1
\endif
\if :{?pw_app}
\else
  \echo 'PRIVPAY_PW_APP missing'
  \quit 1
\endif
\if :{?pw_auditor}
\else
  \echo 'PRIVPAY_PW_AUDITOR missing'
  \quit 1
\endif
\if :{?pw_testadmin}
\else
  \echo 'PRIVPAY_PW_TEST_ADMIN missing'
  \quit 1
\endif

-- Roles: LOGIN, never superuser / createrole. Only the test admin may create databases (to recreate the test DB per run).
CREATE TEMP TABLE _privpay_roles (name text PRIMARY KEY, pw text NOT NULL, extra text NOT NULL);
INSERT INTO _privpay_roles VALUES
  ('privpay_privacy_owner', :'pw_owner',     'NOCREATEDB'),
  ('privpay_app',           :'pw_app',       'NOCREATEDB'),
  ('privpay_auditor',       :'pw_auditor',   'NOCREATEDB'),
  ('privpay_test_admin',    :'pw_testadmin', 'CREATEDB');

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION %s', name, extra)
  FROM _privpay_roles r
 WHERE name LIKE 'privpay\_%'
   AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name)
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION %s PASSWORD %L', name, extra, pw)
  FROM _privpay_roles
 WHERE name LIKE 'privpay\_%'
\gexec

-- The test admin recreates the test DB owned by the schema owner, so it must be a member of that role.
GRANT privpay_privacy_owner TO privpay_test_admin;

-- The connecting admin must be able to SET ROLE to the owner role to create a database owned by it and to run the
-- schema grants below (unless superuser). The membership is temporary: it is revoked at the end of this script.
SELECT NOT rolsuper AS needs_membership FROM pg_roles WHERE rolname = current_user \gset
\if :needs_membership
  GRANT privpay_privacy_owner TO CURRENT_USER;
\endif

SELECT 'CREATE DATABASE privpay_privacy OWNER privpay_privacy_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'privpay_privacy')
\gexec

REVOKE ALL ON DATABASE privpay_privacy FROM PUBLIC;
GRANT CONNECT ON DATABASE privpay_privacy TO privpay_app, privpay_auditor;

\c privpay_privacy
SET ROLE privpay_privacy_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_app, privpay_auditor;
RESET ROLE;

\if :needs_membership
  REVOKE privpay_privacy_owner FROM CURRENT_USER;
\endif

\set QUIET off
SELECT CASE
         WHEN rolsuper THEN 'admin is a superuser: no membership change was made'
         WHEN pg_has_role(current_user, 'privpay_privacy_owner', 'SET') THEN 'WARNING: admin can still SET ROLE privpay_privacy_owner'
         ELSE 'admin membership in privpay_privacy_owner revoked'
       END AS admin_membership
  FROM pg_roles WHERE rolname = current_user;
\echo 'privpay bootstrap done: database privpay_privacy; roles privpay_privacy_owner, privpay_app, privpay_auditor, privpay_test_admin'
