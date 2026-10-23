'use strict';
// `pnpm dev:down [--log-dir <dir>]`: stops the processes that `dev:up` recorded in pids.json and waits until they are
// gone, so an immediate `dev:up` does not meet a port still in use. On Windows this is a hard kill (there is no SIGTERM
// for a child there); the graceful path is tested on Linux in CI.
const { existsSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { DEFAULT_LOG_DIR } = require('./services.cjs');

const ROOT = path.join(__dirname, '..', '..');
const GONE_WAIT_MS = 5000;
const flag = process.argv.indexOf('--log-dir');
const logDir = path.resolve(ROOT, flag === -1 ? DEFAULT_LOG_DIR : process.argv[flag + 1]);
const pidFile = path.join(logDir, 'pids.json');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  if (!existsSync(pidFile)) {
    process.stdout.write('nothing recorded\n');
    return;
  }
  const { started } = JSON.parse(readFileSync(pidFile, 'utf8'));
  for (const proc of started) {
    try {
      process.kill(proc.pid);
      process.stdout.write(`stopped ${proc.name} (port ${String(proc.port)})\n`);
    } catch {
      process.stdout.write(`gone    ${proc.name}\n`);
    }
  }
  const deadline = Date.now() + GONE_WAIT_MS;
  while (Date.now() < deadline && started.some((proc) => alive(proc.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  rmSync(pidFile);
}

main().catch(() => {
  process.exitCode = 1;
});
