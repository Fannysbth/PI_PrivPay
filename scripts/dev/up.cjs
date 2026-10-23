'use strict';
// `pnpm dev:up [--mode proposed|baseline] [--secrets-dir <dir>] [--log-dir <dir>]`: starts the processes of the mode as
// separate node processes from the build (`pnpm build` first), waits for /health, and stays in the foreground; Ctrl+C
// (or `pnpm dev:down`) stops them. Ports and environment come from ./services.cjs. It never reads a secret: it checks
// that the files exist and hands their paths on. Baseline runs on its own disposable databases (N-50).
const { spawn } = require('node:child_process');
const { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const {
  BASELINE_DB_SERVICES,
  BASELINE_DB_SUFFIX,
  CLIENT_SECRET_FILES,
  MODES,
  PRIVACY_KEY_FILES,
  buildPlan,
} = require('./services.cjs');

const ROOT = path.join(__dirname, '..', '..');
const HEALTH_WAIT_SECONDS = 60;

function parseArgs(argv) {
  const options = {
    mode: 'proposed',
    secretsDir: process.env.DEV_SECRETS_DIR || 'secrets',
    logDir: path.join('.dev-run', 'logs'),
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${String(flag)} needs a value`);
    if (flag === '--mode') options.mode = value;
    else if (flag === '--secrets-dir') options.secretsDir = value;
    else if (flag === '--log-dir') options.logDir = value;
    else throw new Error(`unknown option ${String(flag)}`);
  }
  if (!MODES.includes(options.mode)) throw new Error('--mode must be proposed or baseline');
  return options;
}

/** Names of the files that must exist before anything starts; nothing is read. */
function missingFiles(plan, secretsDir, mode) {
  const wanted = [
    ...CLIENT_SECRET_FILES,
    ...(mode === 'proposed' ? PRIVACY_KEY_FILES : []),
  ].map((name) => path.join(secretsDir, name));
  const entries = plan.map((proc) => path.join(ROOT, proc.entry));
  return [...wanted, ...entries].filter((file) => !existsSync(file));
}

/** Baseline databases are made from nothing each run, so the schema is always the baseline one. */
async function prepareBaselineDatabases(out) {
  const common = require(path.join(ROOT, 'packages/common/dist/index.js'));
  const testing = require(path.join(ROOT, 'packages/common/dist/testing/index.js'));
  const pg = common.loadConfig(common.pgConfigSchema, process.env);
  const folders = {
    transaction: 'transaction-service',
    fraud: 'fraud-service',
    notification: 'notification-service',
    reconciliation: 'reconciliation-service',
  };
  for (const service of BASELINE_DB_SERVICES) {
    const db = await testing.createTestDb(pg, { service, suffix: BASELINE_DB_SUFFIX });
    try {
      await common.migrate(db.owner, {
        root: path.join(ROOT, 'services', folders[service], 'migrations'),
        mode: 'baseline',
      });
      out(`${service}: ${db.database} ready`);
    } finally {
      await db.close();
    }
  }
}

async function waitHealthy(port) {
  for (let attempt = 0; attempt < HEALTH_WAIT_SECONDS; attempt += 1) {
    try {
      const answer = await fetch(`http://127.0.0.1:${String(port)}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (answer.ok) return await answer.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return undefined;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = (line) => process.stdout.write(`${line}\n`);
  const logDir = path.resolve(ROOT, options.logDir);
  const secretsDir = path.resolve(ROOT, options.secretsDir);
  const pidFile = path.join(logDir, 'pids.json');
  mkdirSync(logDir, { recursive: true });
  if (existsSync(pidFile)) {
    const before = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (before.started.some((proc) => alive(proc.pid)))
      throw new Error('already running: stop it first with `pnpm dev:down`');
  }
  const plan = buildPlan(options.mode, { secretsDir });
  const missing = missingFiles(plan, secretsDir, options.mode);
  if (missing.length > 0) {
    throw new Error(
      `missing (run \`pnpm build\`, \`pnpm --filter @privpay/dev-idp run make-secrets\` and \`pnpm dev:keys\`):\n  ${missing.join('\n  ')}`,
    );
  }
  if (options.mode === 'baseline') await prepareBaselineDatabases(out);

  const children = [];
  let running = plan.length;
  const stopAll = () => {
    for (const child of children) child.kill();
  };
  process.on('SIGINT', () => {
    stopAll();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopAll();
    process.exit(0);
  });
  for (const proc of plan) {
    const log = openSync(path.join(logDir, `${proc.name}.log`), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, proc.entry)], {
      cwd: ROOT,
      env: { ...process.env, ...proc.env },
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    closeSync(log);
    child.on('exit', (code) => {
      out(`${proc.name} exited (${String(code)})`);
      running -= 1;
      if (running === 0) process.exit(0);
    });
    children.push(Object.assign(child, { planName: proc.name, planPort: proc.port }));
  }
  writeFileSync(
    pidFile,
    `${JSON.stringify({ mode: options.mode, started: children.map((c) => ({ name: c.planName, port: c.planPort, pid: c.pid })) }, null, 2)}\n`,
  );
  let healthy = true;
  for (const child of children) {
    const answer = await waitHealthy(child.planPort);
    healthy &&= answer !== undefined;
    out(
      `${child.planName.padEnd(14)} port ${String(child.planPort)}  ${answer === undefined ? 'NO ANSWER' : `${String(answer.status)} mode=${String(answer.mode)}`}`,
    );
  }
  if (!healthy) {
    stopAll();
    throw new Error(`a process did not answer /health; see ${logDir}`);
  }
  out(`all up in ${options.mode}; logs in ${logDir}; Ctrl+C or \`pnpm dev:down\` stops them`);
  setInterval(() => undefined, 1 << 30);
}

main().catch((error) => {
  process.stderr.write(`dev:up failed: ${error instanceof Error ? error.message : 'error'}\n`);
  process.exit(1);
});
