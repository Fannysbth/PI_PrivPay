#!/bin/sh
# Runs once, when the data directory of one PostgreSQL instance is empty (docker-entrypoint-initdb.d). Creates the
# database of ONE service with its owner and runtime role (and, for Privacy, the audit role), the same shape as
# scripts/db/bootstrap.sql (ADR-0004; invariant 4: one service, one database). Passwords are read from Docker secrets
# inside psql, so they never appear in a command line, an environment variable or a log.
set -eu
: "${PRIVPAY_DB:?}" "${PRIVPAY_OWNER:?}" "${PRIVPAY_APP:?}"
export PRIVPAY_AUDITOR="${PRIVPAY_AUDITOR:-}"
if [ -n "$PRIVPAY_AUDITOR" ]; then has_auditor=true; else has_auditor=false; fi

psql -v ON_ERROR_STOP=1 -v has_auditor="$has_auditor" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv db PRIVPAY_DB
\getenv owner PRIVPAY_OWNER
\getenv app PRIVPAY_APP
\getenv auditor PRIVPAY_AUDITOR
\set pw_owner `cat "/run/secrets/${PRIVPAY_OWNER}_password"`
\set pw_app `cat "/run/secrets/${PRIVPAY_APP}_password"`

CREATE ROLE :"owner" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw_owner';
CREATE ROLE :"app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw_app';
\if :has_auditor
  \set pw_auditor `cat "/run/secrets/${PRIVPAY_AUDITOR}_password"`
  CREATE ROLE :"auditor" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw_auditor';
\endif

CREATE DATABASE :"db" OWNER :"owner";
-- Only the service's own roles may connect (invariant 4).
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"app";
\if :has_auditor
  GRANT CONNECT ON DATABASE :"db" TO :"auditor";
\endif

-- Nobody but the owner may create objects in the public schema; runtime roles only get USAGE.
\c :"db"
SET ROLE :"owner";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app";
\if :has_auditor
  GRANT USAGE ON SCHEMA public TO :"auditor";
\endif
RESET ROLE;
SQL
