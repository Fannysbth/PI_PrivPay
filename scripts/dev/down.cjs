'use strict';
// `pnpm dev:down [--log-dir <dir>]`: stops the processes that `dev:up` recorded in pids.json. On Windows this is a hard
// kill (there is no SIGTERM for a child there); the graceful path is tested on Linux in CI.
const { existsSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const flag = process.argv.indexOf('--log-dir');
const logDir = path.resolve(ROOT, flag === -1 ? path.join('.dev-run', 'logs') : process.argv[flag + 1]);
const pidFile = path.join(logDir, 'pids.json');

if (!existsSync(pidFile)) {
  process.stdout.write('nothing recorded\n');
} else {
  const { started } = JSON.parse(readFileSync(pidFile, 'utf8'));
  for (const proc of started) {
    try {
      process.kill(proc.pid);
      process.stdout.write(`stopped ${proc.name} (port ${String(proc.port)})\n`);
    } catch {
      process.stdout.write(`gone    ${proc.name}\n`);
    }
  }
  rmSync(pidFile);
}
