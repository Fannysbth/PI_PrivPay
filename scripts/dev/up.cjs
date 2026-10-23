'use strict';
// `pnpm dev:up [--mode proposed|baseline] [--secrets-dir <dir>] [--log-dir <dir>]`: starts the processes of the mode as
// separate node processes from the build (`pnpm build` first), waits for /health, and stays in the foreground; Ctrl+C
// (or `pnpm dev:down`) stops them. Ports and environment come from ./services.cjs. It never reads a secret: it checks
// that the files exist and hands their paths on. Baseline runs on its own disposable databases (N-50).
const { spawn } = require('node:child_process');
const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const {
  BASELINE_DB_SERVICES,
  BASELINE_DB_SUFFIX,
  CLIENT_SECRET_FILES,
  DEFAULT_LOG_DIR,
  MODES,
  PRIVACY_KEY_FILES,
  alive,
  buildPlan,
  childEnv,
} = require('./services.cjs');

const ROOT = path.join(__dirname, '..', '..');
const HEALTH_WAIT_MS = 60_000;
const HEALTH_POLL_MS = 500;

function parseArgs(argv) {
  const options = {
    mode: 'proposed',
    secretsDir: process.env.DEV_SECRETS_DIR || 'secrets',
    logDir: DEFAULT_LOG_DIR,
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
  const wanted = [...CLIENT_SECRET_FILES, ...(mode === 'proposed' ? PRIVACY_KEY_FILES : [])].map(
    (name) => path.join(secretsDir, name),
  );
  const entries = plan.map((proc) => path.join(ROOT, proc.entry));
  return [...wanted, ...entries].filter((file) => !existsSync(file));
}

/** Baseline databases are made from nothing each run, so the schema is always the baseline one. */
async function prepareBaselineDatabases(out) {
  const common = require(path.join(ROOT, 'packages/common/dist/index.js'));
  const testing = require(path.join(ROOT, 'packages/common/dist/testing/index.js'));
  const pg = common.loadConfig(common.pgConfigSchema, process.env);
  for (const service of BASELINE_DB_SERVICES) {
    const db = await testing.createTestDb(pg, { service, suffix: BASELINE_DB_SUFFIX });
    try {
      await common.migrate(db.owner, {
        root: path.join(ROOT, 'services', `${service}-service`, 'migrations'),
        mode: 'baseline',
      });
      out(`${service}: ${db.database} ready`);
    } finally {
      await db.close();
    }
  }
}

/** The answer of /health, or undefined when the deadline passes or the process has already exited. */
async function waitHealthy(started, deadline) {
  while (Date.now() < deadline && !started.exited) {
    try {
      const answer = await fetch(`http://127.0.0.1:${String(started.port)}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (answer.ok) return await answer.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return undefined;
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

  let running = plan.length;
  const started = plan.map((proc) => {
    const log = openSync(path.join(logDir, `${proc.name}.log`), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, proc.entry)], {
      cwd: ROOT,
      env: childEnv(process.env, proc),
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    closeSync(log);
    const record = { name: proc.name, port: proc.port, child, exited: false };
    child.on('error', () => {
      out(`${proc.name} could not be started`);
    });
    child.on('exit', (code) => {
      record.exited = true;
      out(`${proc.name} exited (${String(code)})`);
      running -= 1;
      if (running === 0) {
        rmSync(pidFile, { force: true });
        process.exit(0);
      }
    });
    return record;
  });
  // Written before anything is awaited, so a crash from here on cannot leave processes nobody knows about.
  writeFileSync(
    pidFile,
    `${JSON.stringify({ mode: options.mode, started: started.map((s) => ({ name: s.name, port: s.port, pid: s.child.pid })) }, null, 2)}\n`,
  );
  const stopAll = () => {
    for (const record of started) record.child.kill();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopAll();
      rmSync(pidFile, { force: true });
      process.exit(0);
    });
  }

  // All of them are waited for at once under one deadline: the wait is the slowest process, not the sum.
  const deadline = Date.now() + HEALTH_WAIT_MS;
  const answers = await Promise.all(started.map((record) => waitHealthy(record, deadline)));
  let healthy = true;
  started.forEach((record, index) => {
    const answer = answers[index];
    healthy &&= answer !== undefined;
    out(
      `${record.name.padEnd(14)} port ${String(record.port)}  ${answer === undefined ? 'NO ANSWER' : `${String(answer.status)} mode=${String(answer.mode)}`}`,
    );
  });
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
