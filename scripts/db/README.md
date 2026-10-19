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
