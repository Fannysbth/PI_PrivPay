'use strict';
// `pnpm docker:newman <proposed|baseline>`: runs the Postman collection of docs/postman through Kong, with Newman in a
// container on the `edge` network of the RUNNING stack (DK-02a). The stack must have been started with
// docs/postman/compose.postman.yml (the IdP and the SMS simulator on `edge`). TLS is verified against the development CA;
// verification is not switched off. Newman is a pinned image, not a dependency of the repository.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { MODES, caFile } = require('./compose.cjs');

const NEWMAN_IMAGE = 'postman/newman@sha256:d9b5e780ead0026bbb37f3759cd7b10fc8a88cd4030c8266a7c5e343d75a5198';
const root = path.join(__dirname, '..', '..');

function main() {
  const [mode] = process.argv.slice(2);
  if (!MODES.includes(mode)) {
    process.stderr.write('usage: newman.cjs <proposed|baseline>\n');
    return 2;
  }
  const args = [
    'run', '--rm', '--network', `privpay-${mode}_edge`,
    '-v', `${path.join(root, 'docs', 'postman')}:/etc/newman:ro`,
    '-v', `${caFile()}:/ca/ca.crt:ro`,
    NEWMAN_IMAGE,
    'run', 'privpay-manual.postman_collection.json',
    '-e', `privpay-${mode}.postman_environment.json`,
    '--env-var', 'base_url=https://kong:8443',
    '--env-var', 'idp_url=http://idp:4000',
    '--env-var', 'sms_url=http://sms-simulator:4007',
    '--ssl-extra-ca-certs', '/ca/ca.crt',
    '--reporters', 'cli', '--color', 'off', '--disable-unicode',
  ];
  return spawnSync('docker', args, { stdio: 'inherit' }).status ?? 1;
}

process.exitCode = main();
