'use strict';
// `pnpm docker:newman <proposed|baseline>`: runs the Postman collection of docs/postman through Kong, with Newman in a
// container on the `edge` network of the RUNNING stack (DK-02a). The stack must have been started with
// docs/postman/compose.postman.yml (the IdP and the SMS simulator on `edge`). TLS is verified against the development CA;
// verification is not switched off. DK-04: tokens come from Keycloak by password grant; the one (invented) test password is read
// from its secret file into a temporary globals file that is mounted read-only and removed afterwards, so it is never an
// argument of the command. Newman is a pinned image, not a dependency of the repository.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODES, caFile, secretsDir } = require('./compose.cjs');

const NEWMAN_IMAGE = 'postman/newman@sha256:d9b5e780ead0026bbb37f3759cd7b10fc8a88cd4030c8266a7c5e343d75a5198';
const root = path.join(__dirname, '..', '..');

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privpay-newman-'));
  try {
    return run(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run(tmp) {
  const [mode] = process.argv.slice(2);
  if (!MODES.includes(mode)) {
    process.stderr.write('usage: newman.cjs <proposed|baseline>\n');
    return 2;
  }
  // DK-04c: one password per class of user and the secret of the privileged human client, as secret variables (never printed).
  // The harness holds all of them; no service does. password_nasabah is the one password of the test customers, the ones
  // seeded and the ones that /register makes (a fixture of the test: the Gateway holds only this class).
  const read = (name) => fs.readFileSync(path.join(secretsDir(), name), 'utf8').trim();
  const secret = (key, value) => ({ key, value, type: 'secret', enabled: true });
  fs.writeFileSync(
    path.join(tmp, 'globals.json'),
    JSON.stringify({
      values: [
        secret('password_nasabah', read('keycloak_password_customer')),
        secret('password_admin', read('keycloak_password_admin')),
        secret('password_auditor', read('keycloak_password_auditor')),
        secret('password_analis', read('keycloak_password_analyst')),
        secret('password_bank', read('keycloak_password_bank')),
        secret('admin_console_secret', read('admin-console_client_secret')),
      ],
    }),
    { mode: 0o600 },
  );
  const args = [
    'run', '--rm', '--network', `privpay-${mode}_edge`,
    '-v', `${path.join(root, 'docs', 'postman')}:/etc/newman:ro`,
    '-v', `${caFile()}:/ca/ca.crt:ro`,
    '-v', `${tmp}:/secret:ro`,
    NEWMAN_IMAGE,
    'run', 'privpay-manual.postman_collection.json',
    '-e', `privpay-${mode}.postman_environment.json`,
    '--env-var', 'base_url=https://kong:8443',
    '--env-var', 'idp_url=http://keycloak:8080',
    '-g', '/secret/globals.json',
    '--env-var', 'sms_url=http://sms-simulator:4007',
    '--ssl-extra-ca-certs', '/ca/ca.crt',
    '--reporters', 'cli', '--color', 'off', '--disable-unicode',
  ];
  return spawnSync('docker', args, { stdio: 'inherit' }).status ?? 1;
}

process.exitCode = main();
