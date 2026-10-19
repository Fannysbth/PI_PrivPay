#!/usr/bin/env bash
# Runs scripts/db/bootstrap.ps1 twice against one server and fails when the second run changed anything
# (M0-05 idempotency, NFR-09), or when anyone but privpay_test_admin can use a schema owner role afterwards.
#
# Needs: ENV_FILE (the file bootstrap.ps1 reads, see its -EnvFile), the libpq variables PGHOST, PGPORT, PGUSER and
# PGPASSWORD of a role that may read the catalog and connect to the privpay databases (a superuser; it may differ from
# the admin in ENV_FILE), psql, and PowerShell (PWSH, default `pwsh`).
# Nothing here prints a password.
set -euo pipefail

: "${ENV_FILE:?ENV_FILE is not set}"
: "${PGHOST:?PGHOST is not set}"
: "${PGPORT:?PGPORT is not set}"
: "${PGUSER:?PGUSER is not set}"
: "${PGPASSWORD:?PGPASSWORD is not set}"
PWSH="${PWSH:-pwsh}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$HERE/../db"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DATABASES=(privpay_privacy privpay_transaction privpay_fraud privpay_notification privpay_reconciliation)

# PowerShell on Windows needs native paths; on Linux the path is used as it is.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

bootstrap() {
  "$PWSH" -NoProfile -ExecutionPolicy Bypass -File "$(native "$DB_DIR/bootstrap.ps1")" -EnvFile "$(native "$ENV_FILE")" >"$WORK/$1.log" 2>&1 || {
    echo "bootstrap run $1 failed (output follows, it holds no passwords)" >&2
    cat "$WORK/$1.log" >&2
    exit 1
  }
}

snapshot() {
  {
    psql -X -q -d postgres -f "$DB_DIR/snapshot.sql"
    for database in "${DATABASES[@]}"; do
      psql -X -q -d "$database" -f "$DB_DIR/snapshot.sql" | grep '^schema|' \
        || { echo "no schema line for database ${database}" >&2; exit 1; }
    done
  } >"$WORK/$1.txt"
}

# Two empty snapshots would be identical, so each kind of line must be there in the expected number: 12 roles, the
# five databases, five public-schema ACLs.
expect_count() {
  local kind="$1" expected="$2" file="$3" actual
  actual="$(grep -c "^${kind}|" "$file" || true)"
  if [ "$actual" != "$expected" ]; then
    echo "snapshot has ${actual} '${kind}' lines, expected ${expected}: the snapshot is incomplete" >&2
    exit 1
  fi
}

bootstrap first
snapshot first
expect_count role 12 "$WORK/first.txt"
expect_count database 5 "$WORK/first.txt"
expect_count schema 5 "$WORK/first.txt"
bootstrap second
snapshot second

if ! diff -u "$WORK/first.txt" "$WORK/second.txt"; then
  echo "the second bootstrap run changed the roles, databases or grants: it is not idempotent" >&2
  exit 1
fi

# Same property the integration test checks, here against the server the CI created: nobody but the test admin may
# SET ROLE to, or inherit, a schema owner role (ADR-0004, correction of 2026-10-19).
unexpected="$(grep '^membership|privpay_.*_owner|' "$WORK/second.txt" \
  | awk -F'|' '$5 == "t" || $6 == "t" { print $2 "|" $3 }' | grep -v '|privpay_test_admin$' || true)"
if [ -n "$unexpected" ]; then
  echo "unexpected role membership with SET or INHERIT on a schema owner role:" >&2
  echo "$unexpected" >&2
  exit 1
fi

echo "bootstrap is idempotent: $(wc -l <"$WORK/second.txt" | tr -d ' ') catalog lines identical across two runs"
