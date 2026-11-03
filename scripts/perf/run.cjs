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
//   --only <mode>      run one mode only, repeats times      --vus N --warmup 60s --duration 300s
//   --pace saturation|realistic   no pause between requests (default) or a random 0.5 to 1.5 s pause (M7-B); --official runs both, separately
//   --official         the Metodologi parameters; label `resmi`
//   --keep             leave the last stack running (default: `down -v` after each run)
//   --remote-k6        M7-D (N-61): k6 runs on a SECOND laptop (docs/hasil/kinerja/RUNBOOK-dua-mesin.md). The stack is also published on the one LAN
//                      address in PRIVPAY_LAN_IP (deploy/measure/compose.lan.yml: Kong and Keycloak only); the runner prints the k6 command,
//                      waits for k6-summary.json to be copied to the printed folder, then reads CPU and memory when it arrives.
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
  const o = { repeats: 1, first: 'baseline', only: undefined, vus: 10, warmup: '0s', duration: '60s', pace: 'saturation', official: false, keep: false, remote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repeats') o.repeats = Number(next());
    else if (a === '--first') o.first = next();
    else if (a === '--only') o.only = next();
    else if (a === '--vus') o.vus = Number(next());
    else if (a === '--warmup') o.warmup = next();
    else if (a === '--duration') o.duration = next();
    else if (a === '--pace') o.pace = next();
    else if (a === '--official') o.official = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--remote-k6') o.remote = true;
    else throw new RangeError(`unknown option ${a}`);
  }
  const given = argv.filter((a) => a.startsWith('--') && a !== '--official' && a !== '--keep' && a !== '--remote-k6');
  if (o.official && given.length > 0) throw new RangeError('--official takes no other option (only --keep and --remote-k6)');
  plan.pacesFor(false, o.pace);
  for (const key of ['repeats', 'vus']) {
    if (!Number.isInteger(o[key]) || o[key] < 1) throw new RangeError(`${key} must be a whole number`);
  }
  if (o.vus > 5000) throw new RangeError('vus is too large for the canary index range');
  plan.seconds(o.warmup);
  plan.seconds(o.duration);
  if (o.official) Object.assign(o, { vus: plan.OFFICIAL.vus, warmup: plan.OFFICIAL.warmup, duration: plan.OFFICIAL.duration, repeats: plan.OFFICIAL.repeats });
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

const LAN_FILE = path.join(root, 'deploy', 'measure', 'compose.lan.yml');
const FILES = ['-f', path.join(root, 'docs', 'postman', 'compose.postman.yml'), '-f', path.join(root, 'deploy', 'measure', 'compose.perf.yml'), '-f', path.join(root, 'deploy', 'compose', 'docker-compose.monitoring.yml'), '--profile', 'monitoring'];
const lanEnv = () => (process.env['PRIVPAY_LAN_IP'] === undefined ? {} : { PRIVPAY_LAN_IP: plan.assertLanIp(process.env['PRIVPAY_LAN_IP']) });
const composeEnvFor = (mode) => ({ ...composeEnv(mode), RATE_LIMIT_ENABLED: 'false', KONG_RATE_LIMIT_PER_MINUTE: '100000', COMPOSE_PARALLEL_LIMIT: '1' });
// The LAN file is read only for a remote-k6 run; `down` of the other mode needs no address because it removes containers, not ports.
// The address is validated and passed on only when the LAN file is in the set, so a stale PRIVPAY_LAN_IP cannot break an ordinary run or its cleanup.
const compose = (mode, rest, stdio = 'inherit', files = FILES) => run('docker', composeArgs(mode, [...files, ...rest]), { stdio, env: { ...composeEnvFor(mode), ...(files.includes(LAN_FILE) ? lanEnv() : {}) } });

function imageVersions(mode) {
  const names = docker(['ps', '--filter', `label=com.docker.compose.project=privpay-${mode}`, '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const out = {};
  for (const line of docker(['inspect', '-f', '{{.Name}} {{.Config.Image}} {{.Image}}', ...names]).split('\n').filter(Boolean)) {
    const [name, image, id] = line.split(' ');
    out[name.replace(`/privpay-${mode}-`, '').replace(/-1$/, '')] = `${image} ${String(id).slice(0, 19)}`;
  }
  return out;
}

function promQuery(mode, expr, label = plan.SERVICE_LABEL) {
  const url = `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expr)}`;
  const body = JSON.parse(docker(['exec', `privpay-${mode}-prometheus-1`, 'wget', '-qO-', url]));
  const bySvc = {};
  for (const r of body.data.result) bySvc[r.metric[label]] = Number(r.value[1]);
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
  if (o.official && info.commit !== o.startCommit) throw new Error('the commit changed during the official session');
  const freeBefore = os.freemem();
  const meta = { ...info, mode, run: entry.run, date: started.toISOString(), official: o.official, label, params: { vus: o.vus, warmup: o.warmup, duration: o.duration, pace: o.pace }, k6Image: plan.K6_IMAGE, freeMemoryBeforeGB: +(freeBefore / GB).toFixed(2), host: { cpus: os.cpus().length, totalMemoryGB: +(os.totalmem() / GB).toFixed(2), os: `${os.type()} ${os.release()}` } };
  const result = { meta, status: 'ok' };
  const stem = `vu${String(o.vus)}-${o.pace}-run-${String(entry.run).padStart(2, '0')}-${mode}`;
  const taken = fs.existsSync(path.join(outRoot, `${stem}.json`));
  const file = path.join(outRoot, taken ? `${stem}-${started.toISOString().replace(/[-:.]/g, '')}.json` : `${stem}.json`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privpay-k6-'));
  const files = o.remote ? [...FILES, '-f', LAN_FILE] : FILES;
  try {
    if (freeBefore < 1.0 * GB) throw new Error(`free memory ${(freeBefore / GB).toFixed(2)} GB before the run; stopping`);
    process.stdout.write(`run ${entry.run} ${mode}: fresh stack\n`);
    // Both modes publish the same loopback ports: a stack left over from the other mode would make this one fail to start.
    process.stdout.write(`run ${entry.run} ${mode}: removing the ${mode === 'baseline' ? 'proposed' : 'baseline'} stack if it is running
`);
    compose(mode === 'baseline' ? 'proposed' : 'baseline', ['down', '-v', '--remove-orphans'], 'ignore');
    compose(mode, ['down', '-v', '--remove-orphans'], 'inherit', files);
    let up = compose(mode, ['up', '-d', '--wait'], 'inherit', files);
    if (up.status !== 0) {
      // Docker frees a published loopback port a moment after `down`; one retry on a clean slate, then give up (seen in M7-A).
      compose(mode, ['down', '-v', '--remove-orphans'], 'ignore', files);
      await new Promise((resolve) => setTimeout(resolve, 15000));
      meta.upRetried = true;
      up = compose(mode, ['up', '-d', '--wait'], 'inherit', files);
    }
    if (up.status !== 0) throw new Error('the stack did not come up');
    meta.imageVersions = imageVersions(mode);
    meta.prometheusTargetsBefore = prometheusTargets(mode);
    // The canary indices of this run: distinct per run, below the 100000 of the canary builder.
    const runBase = Math.floor(Date.now() / 1000) % (99000 - o.vus);
    const k6Options = { containerName: `privpay-k6-run-${mode}`, caFile: caFile(), passwordFile: path.join(secretsDir(), 'keycloak_password_customer'), scriptDir: path.join(root, 'tests', 'performance'), outDir: tmp, mode, vus: o.vus, warmup: o.warmup, duration: o.duration, pace: o.pace, runBase };
    let lowest = freeBefore;
    // One memory sample for both ways of waiting: remembers the lowest value and says whether the abort line is crossed.
    const lowMemory = () => {
      const free = os.freemem();
      lowest = Math.min(lowest, free);
      return free < ABORT_BELOW;
    };
    const summaryFile = path.join(tmp, 'k6-summary.json');
    let code = 0; // local k6 only: the remote k6 exit code is never seen (recorded as null)
    if (o.remote) {
      // The second laptop runs k6; this one waits for its summary and reads CPU and memory when it arrives (no k6 stderr here).
      const lan = plan.lanTarget(process.env['PRIVPAY_LAN_IP'] ?? '', Number(process.env['KONG_LAN_PORT'] ?? 4443), Number(process.env['IDP_LAN_PORT'] ?? 8080));
      meta.remoteK6 = true;
      process.stdout.write(`run ${entry.run} ${mode}: start k6 on the second laptop with:
  docker ${plan.k6DockerArgs({ ...k6Options, ...lan, caFile: '<CA>', passwordFile: '<PASSWORD-FILE>', scriptDir: '<SCRIPT-DIR>', outDir: '<OUT-DIR>' }).join(' ')}
  then copy <OUT-DIR>/k6-summary.json to ${tmp}
`);
      const limit = Date.now() + (plan.seconds(o.warmup) + plan.seconds(o.duration) + 1800) * 1000;
      while (!fs.existsSync(summaryFile) && result.status === 'ok') {
        if (Date.now() > limit) { result.status = 'remote-k6-timeout'; break; }
        if (lowMemory()) {
          result.status = 'aborted-low-memory';
          process.stdout.write('free memory is below the abort line: STOP k6 on the second laptop now (Ctrl+C)\n');
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      // A copy in progress can leave a half file: wait until it parses (a few tries), so a truncated summary does not fail the run.
      for (let tries = 0; tries < 12 && fs.existsSync(summaryFile); tries += 1) {
        try { JSON.parse(fs.readFileSync(summaryFile, 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5000)); }
      }
      meta.summaryArrivedAt = new Date().toISOString();
      result.resourcesNote = 'remote k6: CPU and memory are evaluated when the summary arrived here, so the window may end a little after k6 did';
    } else {
      const k6 = spawn('docker', plan.k6DockerArgs({ ...k6Options, network: `privpay-${mode}_edge` }), { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      k6.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      const watch = setInterval(() => {
        if (lowMemory()) { result.status = 'aborted-low-memory'; run('docker', ['kill', `privpay-k6-run-${mode}`]); }
      }, 5000);
      code = await new Promise((resolve, reject) => {
        k6.on('error', reject);
        k6.on('close', resolve);
      }).finally(() => clearInterval(watch));
      if (result.status === 'ok' && code !== 0) { result.status = 'k6-failed'; result.k6Stderr = stderr.replace(/\s+/g, ' ').slice(-600); }
    }
    meta.freeMemoryLowestGB = +(lowest / GB).toFixed(2);
    meta.k6ExitCode = o.remote ? null : code;
    if (fs.existsSync(summaryFile)) result.k6 = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    // Remote only: how long after k6 ended (its own clock) the summary arrived here; the resource window is that much too late. Needs similar clocks.
    if (o.remote && result.k6?.endedAt !== undefined) meta.summaryLagSeconds = Math.round((Date.parse(meta.summaryArrivedAt) - Date.parse(result.k6.endedAt)) / 1000);
    const window = plan.seconds(o.duration);
    const q = plan.resourceQueries(window);
    result.resources = { windowSeconds: window, note: 'cAdvisor through Prometheus; window = the measured phase, evaluated when k6 ended (the warm-up before it is outside the window)', cpuCoresMean: promQuery(mode, q.cpuCoresMean), memoryBytesPeak: promQuery(mode, q.memoryBytesPeak), memoryBytesMean: promQuery(mode, q.memoryBytesMean) };
    // M7-D: 5xx answers per service since the stack started (a fresh stack per run). Timeouts and retries are not metered by the services.
    result.errors5xxByInstance = promQuery(mode, plan.errorQueries().http5xxByInstance, 'instance'); // keyed host:port; {} = no 5xx series, so also read prometheusTargetsAfter
    meta.prometheusTargetsAfter = prometheusTargets(mode);
  } catch (error) {
    result.status = 'error';
    result.error = String(error instanceof Error ? error.message : error).slice(0, 400);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!o.keep) compose(mode, ['down', '-v', '--remove-orphans'], 'ignore', files);
  }
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`run ${entry.run} ${mode}: ${result.status}; lowest free memory ${meta.freeMemoryLowestGB ?? '?'} GB; ${path.relative(root, file)}\n`);
  return result.status;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.official && !plan.isOfficialShape(o)) throw new RangeError('--official needs the Metodologi parameters');
  if (o.remote) plan.assertLanIp(process.env['PRIVPAY_LAN_IP'] ?? '');
  const label = o.official ? 'resmi' : 'kesiapan';
  const start = commitInfo();
  if (o.official && !start.treeClean) throw new Error('an official run needs a clean tree');
  o.startCommit = start.commit;
  const outRoot = path.join(root, 'docs', 'hasil', 'kinerja', label);
  fs.mkdirSync(outRoot, { recursive: true });
  const order = o.only === undefined ? plan.alternation(o.repeats, o.first) : Array.from({ length: o.repeats }, (_, i) => ({ run: i + 1, mode: o.only }));
  if (order.some((e) => e.mode !== 'baseline' && e.mode !== 'proposed')) throw new RangeError('mode must be baseline or proposed');
  // An official session runs each pace as its own alternating set; the pace never changes inside a set.
  for (const pace of plan.pacesFor(o.official, o.pace)) {
    const set = { ...o, pace };
    for (const entry of order) {
      if ((await oneRun(entry, set, label, outRoot)) !== 'ok') {
        if (o.official) process.stderr.write(`the official session is INCOMPLETE: stopped in the ${pace} set
`);
        return 1;
      }
    }
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${error instanceof Error ? error.message : 'error'}\n`); process.exitCode = 2; });
