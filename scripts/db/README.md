# scripts/db

`bootstrap.ps1` (with `bootstrap.sql`) prepares a local PostgreSQL server for PrivPay (ADR-0004). It creates, and only
ever touches, objects whose names start with `privpay_`:

| Service | Database | Owner role (migrations) | Runtime role | Other |
| --- | --- | --- | --- | --- |
| privacy | `privpay_privacy` | `privpay_privacy_owner` | `privpay_app` | `privpay_auditor` (read-only audit) |
| transaction | `privpay_transaction` | `privpay_transaction_owner` | `privpay_transaction_app` | |
| fraud | `privpay_fraud` | `privpay_fraud_owner` | `privpay_fraud_app` | |
| notification | `privpay_notification` | `privpay_notification_owner` | `privpay_notification_app` | |
| reconciliation | `privpay_reconciliation` | `privpay_reconciliation_owner` | `privpay_reconciliation_app` | |

plus `privpay_test_admin` (may create databases, so tests can recreate `privpay_<service>_test_<suffix>`). Only a
service's own roles may connect to its database; the runtime roles never own the schema. No role is a superuser.

## Run

1. Put `PG_HOST`, `PG_PORT`, `PG_ADMIN_USER`, and `PG_ADMIN_PASSWORD` (or `PG_ADMIN_PASSWORD_FILE`) in the repo's
   `.env` (see `.env.example`). The admin may be a superuser or a role with `CREATEROLE` and `CREATEDB`.
2. `powershell -ExecutionPolicy Bypass -File scripts/db/bootstrap.ps1`
3. Passwords for the `privpay_*` roles are generated into `secrets/<role>_password` (never committed) and re-synced on
   every run; the script is idempotent. It never prints a password, and the admin password never goes on a command
   line.

A non-superuser admin is given `SET ROLE` on the owner roles only while the script runs and loses it at the end; the
final line says so (`admin membership in the privpay_*_owner roles revoked`). If the script fails halfway, run it again.

`-EnvFile <path>` reads the settings from another file (used to try the script on a throwaway server).

## Integration tests

`pnpm test:integration` needs the roles above. Copy `.env.test.example` to `.env.test` (host, port, secrets directory;
no passwords) or export `PG_HOST`, `PG_PORT`, `PG_SECRETS_DIR`.

## Test databases left on the server

`createTestDb` recreates `privpay_<service>_test_<suffix>` at the start of each test and **does not drop it afterwards**
(so a failed test can be inspected). The number is bounded by the distinct suffixes in the test files (about thirty,
roughly 8 MB each), not by the number of runs. To see them, and to remove them:

```
pnpm db:test-databases          # list: service databases and test leftovers, with open sessions; touches nothing
pnpm db:test-databases drop     # shows the test leftovers, then needs the typed answer "DROP <count>"
```

Only names of the form `privpay_<one of the five services>_test_<[a-z0-9]{1,20}>` can be dropped, never a service
database or another project's database; there is no flag that skips the confirmation, and without a terminal the
prompt is never answered. A database that still has a session of a role the test admin may not end (a superuser such
as **pgAdmin** browsing it) is reported as `42501` and stays; disconnect that session and run it again. The same
sessions make `createTestDb` fail with "permission denied to terminate process" after five seconds.

## What the admin keeps

PostgreSQL 16+ gives the role that runs `CREATE ROLE` the ADMIN option on it. The script cannot remove that as a
non-superuser, so the admin stays listed in `pg_auth_members` for the owner roles, but without `SET` or `INHERIT`: it
can use an owner role only by first granting itself that right again. The integration test checks `SET`/`INHERIT`.
