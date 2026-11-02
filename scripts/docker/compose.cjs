'use strict';
// `pnpm docker:compose <proposed|baseline> <docker compose arguments...>`: runs Docker Compose with the shared file and the
// file of the chosen condition (ADR-0003), so nobody has to remember the pair. Examples:
//   pnpm docker:compose proposed up -d --build --wait
//   pnpm docker:compose baseline run --rm smoke
//   pnpm docker:compose proposed down          (keeps the volumes; add -v to drop the data of this project only)
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MODES = Object.freeze(['proposed', 'baseline']);
const COMPOSE_DIR = path.join(__dirname, '..', '..', 'deploy', 'compose');

/** The arguments after `docker`: the files first, then what the caller asked for. */
function composeArgs(mode, rest) {
  if (!MODES.includes(mode)) throw new RangeError('mode must be proposed or baseline');
  return [
    'compose',
    '-f',
    path.join(COMPOSE_DIR, 'docker-compose.yml'),
    '-f',
    path.join(COMPOSE_DIR, `mode.${mode}.yml`),
    ...rest,
  ];
}

/** The folder of the Compose secrets (git-ignored), and the public certificate of the development CA inside it. */
const secretsDir = () => process.env['DOCKER_SECRETS_DIR'] ?? path.join(__dirname, '..', '..', 'secrets', 'docker');
const caFile = () => path.join(secretsDir(), 'tls_ca.crt');

/** The environment of a compose call: the monitoring file picks its Prometheus configuration from PRIVPAY_MODE (M7-A). */
const composeEnv = (mode) => ({ ...process.env, PRIVPAY_MODE: mode });

module.exports = { composeArgs, composeEnv, MODES, caFile, secretsDir };

if (require.main === module) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    const result = spawnSync('docker', composeArgs(mode, rest), { stdio: 'inherit', env: composeEnv(mode) });
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'error'}\n`);
    process.exitCode = 2;
  }
}
