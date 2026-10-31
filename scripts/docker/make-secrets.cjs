'use strict';
// `pnpm docker:secrets`: makes every secret file the Compose stack mounts, in secrets/docker/ (git-ignored) or
// DOCKER_SECRETS_DIR. It never reads a file and never overwrites one ('wx'), so a second run changes nothing; only file
// names are printed, never a value (DK-01, S-60). The files are separate from the ones of the local phase (scripts/db,
// dev:keys), so a Docker database never shares a password with the PostgreSQL on this machine.
const { randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { CLIENT_SECRET_FILES, PRIVACY_KEY_FILES } = require('../dev/services.cjs');

/** Owner, runtime and audit roles of each service database (SERVICE_DBS in packages/common/src/db.ts). */
const DB_ROLES = Object.freeze([
  'privpay_privacy_owner',
  'privpay_app',
  'privpay_auditor',
  'privpay_transaction_owner',
  'privpay_transaction_app',
  'privpay_fraud_owner',
  'privpay_fraud_app',
  'privpay_notification_owner',
  'privpay_notification_app',
  'privpay_reconciliation_owner',
  'privpay_reconciliation_app',
]);
const SERVICES = Object.freeze(['privacy', 'transaction', 'fraud', 'notification', 'reconciliation']);

/** name -> how to generate it. Keys are hex, the rest base64url, like the local phase. */
function plan() {
  const files = new Map();
  for (const name of PRIVACY_KEY_FILES) files.set(name, () => randomBytes(32).toString('hex'));
  for (const name of CLIENT_SECRET_FILES) files.set(name, () => randomBytes(32).toString('base64url'));
  for (const role of DB_ROLES) files.set(`${role}_password`, () => randomBytes(24).toString('base64url'));
  // The superuser of each PostgreSQL instance: only the instance itself reads it, no service gets it.
  for (const service of SERVICES) {
    files.set(`pg_${service}_admin_password`, () => randomBytes(24).toString('base64url'));
  }
  // DK-02b: proves Kong to the adapter (X-Edge-Auth); only Kong and the adapter in the proposed condition mount it.
  files.set('edge_adapter_secret', () => randomBytes(32).toString('base64url'));
  // DK-04: the client that manages users in Keycloak (registration, compensation) and the one password of the fictional test users.
  files.set('idp-admin_client_secret', () => randomBytes(32).toString('base64url'));
  files.set('keycloak_dev_user_password', () => randomBytes(18).toString('base64url'));
  files.set('grafana_admin_password', () => randomBytes(18).toString('base64url'));
  return files;
}

function makeSecrets(dir, out) {
  // The folder is owner-only on the host; the files are readable inside it so a non-root container user can read the
  // bind-mounted copy on Linux. Windows ignores both modes (secrets/README.md).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created = [];
  for (const [name, generate] of plan()) {
    const file = path.join(dir, name);
    try {
      writeFileSync(file, `${generate()}\n`, { flag: 'wx', mode: 0o644 });
      created.push(name);
      out(`created ${file}`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      out(`kept    ${file}`);
    }
  }
  return created;
}

module.exports = { makeSecrets, plan, DB_ROLES, SERVICES };

if (require.main === module) {
  makeSecrets(process.env.DOCKER_SECRETS_DIR || './secrets/docker', (line) => process.stdout.write(`${line}\n`));
}
