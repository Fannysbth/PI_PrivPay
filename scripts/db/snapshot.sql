-- Deterministic picture of everything scripts/db/bootstrap.sql creates, for comparing two runs (M0-05, M0-07).
-- Password hashes are left out on purpose: each run re-salts them. Run as the admin, one database per psql call:
--   psql -X -d postgres -f snapshot.sql        (roles, databases, memberships)
--   psql -X -d <privpay_db> -f snapshot.sql    (the same text plus that database's public schema ACL)
\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'

SELECT 'role', rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
  FROM pg_roles WHERE rolname LIKE 'privpay\_%' ORDER BY rolname;

SELECT 'database', datname, pg_get_userbyid(datdba), coalesce(datacl::text, '-')
  FROM pg_database
 WHERE datname LIKE 'privpay\_%' AND datname NOT LIKE 'privpay\_%\_test\_%'  -- test databases come from the harness, not the bootstrap
 ORDER BY datname;

SELECT 'membership', o.rolname, m.rolname, am.admin_option, am.set_option, am.inherit_option
  FROM pg_auth_members am
  JOIN pg_roles o ON o.oid = am.roleid
  JOIN pg_roles m ON m.oid = am.member
 WHERE o.rolname LIKE 'privpay\_%' OR m.rolname LIKE 'privpay\_%'
 ORDER BY o.rolname, m.rolname;

SELECT 'schema', current_database(), nspname, pg_get_userbyid(nspowner), coalesce(nspacl::text, '-')
  FROM pg_namespace WHERE nspname = 'public' AND current_database() LIKE 'privpay\_%';
