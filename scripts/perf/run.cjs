'use strict';
// `pnpm perf:run [options]` (M7-A): alternating runs of the k6 mixed scenario (tests/performance/mixed.k6.js) against the Compose
// stack, one mode at a time, with a FRESH stack per run (`down -v`, then `up`): the database is reset before every run
// (Metodologi D.5). k6 runs in a pinned image (scripts/perf/plan.cjs); nothing is installed on the host and no dependency is added.
//
// Each run writes one JSON file in docs/hasil/kinerja/<kesiapan|resmi>/ with the commit, mode, date, whether the tree was clean,
// the load parameters, the image versions, the k6 summary and CPU/memory per container from cAdvisor (through Prometheus).
// A run that does not have the Metodologi parameters is a READINESS run: its file says `official: false` and it makes no claim.
// The official run is `--official` (100 users, 60 s warm-up, 300 s, 5 repeats) and is refused with any other parameter.
//
//   --repeats N        pairs of runs (default 1)             --first baseline|proposed   which mode starts (default baseline)
//   --only <mode>      run one mode only, repeats times      --vus N --warmup 60s --duration 300s --think-ms N
//   --official         the Metodologi parameters; label `resmi`
//   --keep             leave the last stack running (default: `down -v` after each run)
// Safety: free memory is read before each run and every 5 s during it; at or below 0.5 GB the load is stopped and the run is
// written as `aborted`.
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { composeArgs, composeEnv, caFile, secretsDir } = require('../docker/compose.cjs');
const plan = require('./plan.cjs');

const root = path.join(__dirname, '..', '..');
const GB = 1024 ** 3;
const ABORT_BELOW = 0.5 * GB;

function parse(argv) {
  const o = { repeats: 1, first: 'baseline', only: undefined, vus: 10, warmup: '0s', duration: '60s', thinkMs: 0, official: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repeats') o.repeats = Number(next());
    else if (a === '--first') o.first = next();
    else if (a === '--only') o.only = next();
    else if (a === '--vus') o.vus = Number(next());
    else if (a === '--warmup') o.warmup = next();
    else if (a === '--duration') o.duration = next();
    else if (a === '--think-ms') o.thinkMs = Number(next());
    else if (a === '--official') o.official = true;
    else if (a === '--keep') o.keep = true;
    else throw new RangeError(`unknown option ${a}`);
  }
  if (o.official) Object.assign(o, { vus: plan.OFFICIAL.vus, warmup: plan.OFFICIAL.warmup, duration: plan.OFFICIAL.duration, thinkMs: plan.OFFICIAL.thinkMs, repeats: plan.OFFICIAL.repeats });
  return o;
}

const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options });
const docker = (args) => {
  const done = run('docker', args);
  if (done.status !== 0) throw new Error(`docker ${args[0]} failed: ${(done.stderr || '').slice(0, 300)}`);
  return done.stdout;
};

/** The commit and whether the tree is clean; docs/hasil holds the results themselves and is not counted (as tests/measure/commit-info.ts). */
function commitInfo() {
  const git = (args) => {
    const done = run('git', args, { cwd: root });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed; the commit of the run is unknown`);
    return done.stdout.trim();
  };
  return { commit: git(['rev-parse', 'HEAD']), treeClean: git(['status', '--porcelain', '--', '.', ':(exclude)docs/hasil']).length === 0 };
}

const FILES = ['-f', path.join(root, 'docs', 'postman', 'compose.postman.yml'), '-f', path.join(root, 'deploy', 'measure', 'compose.perf.yml'), '-f', path.join(root, 'deploy', 'compose', 'docker-compose.monitoring.yml'), '--profile', 'monitoring'];
const composeEnvFor = (mode) => ({ ...composeEnv(mode), RATE_LIMIT_ENABLED: 'false', KONG_RATE_LIMIT_PER_MINUTE: '100000', COMPOSE_PARALLEL_LIMIT: '1' });
const compose = (mode, rest, stdio = 'inherit') => run('docker', composeArgs(mode, [...FILES, ...rest]), { stdio, env: composeEnvFor(mode) });

function imageVersions(mode) {
  const out = {};
  const names = docker(['ps', '--filter', `label=com.docker.compose.project=privpay-${mode}`, '--format', '{{.Names}}']).split('\n').filter(Boolean);
  for (const name of names) {
    const [image, id] = docker(['inspect', '-f', '{{.Config.Image}} {{.Image}}', name]).trim().split(' ');
    out[name.replace(`privpay-${mode}-`, '').replace(/-1$/, '')] = `${image} ${String(id).slice(0, 19)}`;
  }
  return out;
}

function promQuery(mode, expr) {
  const url = `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expr)}`;
  const body = JSON.parse(docker(['exec', `privpay-${mode}-prometheus-1`, 'wget', '-qO-', url]));
  const bySvc = {};
  for (const r of body.data.result) bySvc[r.metric[plan.SERVICE_LABEL]] = Number(r.value[1]);
  return bySvc;
}

function prometheusTargets(mode) {
  const body = JSON.parse(docker(['exec', `privpay-${mode}-prometheus-1`, 'wget', '-qO-', 'http://127.0.0.1:9090/api/v1/targets']));
  return body.data.activeTargets.map((t) => ({ job: t.labels.job, instance: t.labels.instance, health: t.health }));
}

async function oneRun(entry, o, label, outRoot) {
  const { mode } = entry;
  const started = new Date();
  const info = commitInfo();
  const freeBefore = os.freemem();
  const meta = { ...info, mode, run: entry.run, date: started.toISOString(), official: o.official, label, params: { vus: o.vus, warmup: o.warmup, duration: o.duration, thinkMs: o.thinkMs }, k6Image: plan.K6_IMAGE, freeMemoryBeforeGB: +(freeBefore / GB).toFixed(2), host: { cpus: os.cpus().length, totalMemoryGB: +(os.totalmem() / GB).toFixed(2), os: `${os.type()} ${os.release()}` } };
  const result = { meta, status: 'ok' };
  const file = path.join(outRoot, `vu${String(o.vus)}-run-${String(entry.run).padStart(2, "0")}-${mode}.json`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privpay-k6-'));
  try {
    if (freeBefore < 1.0 * GB) throw new Error(`free memory ${(freeBefore / GB).toFixed(2)} GB before the run; stopping`);
    process.stdout.write(`run ${entry.run} ${mode}: fresh stack\n`);
    compose(mode, ['down', '-v', '--remove-orphans']);
    let up = compose(mode, ['up', '-d', '--wait']);
    if (up.status !== 0) {
      // Docker frees a published loopback port a moment after `down`; one retry on a clean slate, then give up (seen in M7-A).
      compose(mode, ['down', '-v', '--remove-orphans'], 'ignore');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
      up = compose(mode, ['up', '-d', '--wait']);
    }
    if (up.status !== 0) throw new Error('the stack did not come up');
    meta.imageVersions = imageVersions(mode);
    meta.prometheusTargetsBefore = prometheusTargets(mode);
    // The canary indices of this run: distinct per run, below the 100000 of the canary builder.
    const runBase = Math.floor(Date.now() / 1000) % (99000 - o.vus);
    const k6 = spawn('docker', plan.k6DockerArgs({ containerName: `privpay-k6-run-${mode}`, network: `privpay-${mode}_edge`, caFile: caFile(), passwordFile: path.join(secretsDir(), 'keycloak_password_customer'), scriptDir: path.join(root, 'tests', 'performance'), outDir: tmp, mode, vus: o.vus, warmup: o.warmup, duration: o.duration, thinkMs: o.thinkMs, runBase }), { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    k6.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    let lowest = freeBefore;
    const watch = setInterval(() => {
      lowest = Math.min(lowest, os.freemem());
      if (os.freemem() < ABORT_BELOW) { result.status = 'aborted-low-memory'; run('docker', ['kill', `privpay-k6-run-${mode}`]); }
    }, 5000);
    const code = await new Promise((resolve) => k6.on('close', resolve));
    clearInterval(watch);
    meta.freeMemoryLowestGB = +(lowest / GB).toFixed(2);
    meta.k6ExitCode = code;
    if (result.status === 'ok' && code !== 0) { result.status = 'k6-failed'; result.k6Stderr = stderr.replace(/\s+/g, ' ').slice(-600); }
    const summaryFile = path.join(tmp, 'k6-summary.json');
    if (fs.existsSync(summaryFile)) result.k6 = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    const window = plan.seconds(o.duration);
    const q = plan.resourceQueries(window);
    result.resources = { windowSeconds: window, note: 'cAdvisor through Prometheus; window = the measured phase, evaluated when k6 ended (the warm-up before it is outside the window)', cpuCoresMean: promQuery(mode, q.cpuCoresMean), memoryBytesPeak: promQuery(mode, q.memoryBytesPeak), memoryBytesMean: promQuery(mode, q.memoryBytesMean) };
    meta.prometheusTargetsAfter = prometheusTargets(mode);
  } catch (error) {
    result.status = 'error';
    result.error = String(error instanceof Error ? error.message : error).slice(0, 400);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!o.keep) compose(mode, ['down', '-v', '--remove-orphans'], 'ignore');
  }
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`run ${entry.run} ${mode}: ${result.status}; lowest free memory ${meta.freeMemoryLowestGB ?? '?'} GB; ${path.relative(root, file)}\n`);
  return result.status;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.official && !plan.isOfficialShape(o)) throw new RangeError('--official needs the Metodologi parameters');
  const label = o.official ? 'resmi' : 'kesiapan';
  const outRoot = path.join(root, 'docs', 'hasil', 'kinerja', label);
  fs.mkdirSync(outRoot, { recursive: true });
  const order = o.only === undefined ? plan.alternation(o.repeats, o.first) : Array.from({ length: o.repeats }, (_, i) => ({ run: i + 1, mode: o.only }));
  if (order.some((e) => e.mode !== 'baseline' && e.mode !== 'proposed')) throw new RangeError('mode must be baseline or proposed');
  let failed = 0;
  for (const entry of order) {
    const status = await oneRun(entry, o, label, outRoot);
    if (status !== 'ok') { failed += 1; break; }
  }
  return failed === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${error instanceof Error ? error.message : 'error'}\n`); process.exitCode = 2; });
