'use strict';
// M7-C (Metodologi D.4, "mikrobenchmark"): the cost of the token-issue operation alone, apart from the end-to-end latency of k6.
// `node scripts/perf/token-microbench.cjs [--iterations N] [--warmup N]` (after `pnpm build`). It runs the REAL TokenMint of the
// Privacy Service (HMAC-SHA256 over the length-prefixed parts, "PSEU-" + 8 upper-case hex) from the built output, with throwaway
// keys made in memory by randomBytes: no key file, no secret and no environment value is read. No database, no network, no
// dependency. It is a script, not a Jest suite, so the Jest worker and the test-runner do not disturb the timing.
// The file is written to docs/hasil/kinerja/kesiapan/ and is a READINESS file (`official: false`); a number from a laptop is not
// a result for the thesis (ADR-0004).
const { randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const GB = 1024 ** 3;
const TOKEN_SHAPE = /^PSEU-[0-9A-F]{8}$/;

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted, p) {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Summary of per-call durations (nanoseconds). Copies the input before sorting. */
function summarize(samplesNs) {
  const sorted = [...samplesNs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  return {
    count: sorted.length,
    minNs: sorted[0],
    meanNs: total / sorted.length,
    p50Ns: percentile(sorted, 50),
    p95Ns: percentile(sorted, 95),
    p99Ns: percentile(sorted, 99),
    maxNs: sorted[sorted.length - 1],
  };
}

function parse(argv) {
  const o = { iterations: 200000, warmup: 20000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--iterations') o.iterations = Number(argv[++i]);
    else if (argv[i] === '--warmup') o.warmup = Number(argv[++i]);
    else throw new RangeError(`unknown option ${argv[i]}`);
  }
  for (const key of ['iterations', 'warmup']) {
    if (!Number.isInteger(o[key]) || o[key] < 1) throw new RangeError(`${key} must be a whole number`);
  }
  return o;
}

function git(args) {
  const done = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed`);
  return done.stdout.trim();
}

function loadMint() {
  const derive = path.join(root, 'services', 'privacy-service', 'dist', 'crypto', 'derive.js');
  const keys = path.join(root, 'services', 'privacy-service', 'dist', 'crypto', 'keys.js');
  if (!fs.existsSync(derive)) throw new Error('services/privacy-service/dist is missing: run `pnpm build` first');
  const { TokenMint } = require(derive);
  const { createKeys } = require(keys);
  // Three different 32-byte keys (FR-30) that exist only in this process.
  const material = { token: randomBytes(32), index: randomBytes(32), field: new Map([[1, randomBytes(32)]]), fieldVersion: 1 };
  return new TokenMint(createKeys(material));
}

function main() {
  const o = parse(process.argv.slice(2));
  const mint = loadMint();
  const inputs = Array.from({ length: 1024 }, () => ({ subjectType: 'CUSTOMER', subjectId: randomUUID(), serviceId: 'TRANSACTION', purpose: 'TRANSACTION_PROCESSING', nonce: randomUUID() }));
  const once = (i) => mint.mint(inputs[i % inputs.length]);
  for (let i = 0; i < o.warmup; i += 1) once(i);
  const samples = new Array(o.iterations);
  let last = '';
  for (let i = 0; i < o.iterations; i += 1) {
    const start = process.hrtime.bigint();
    last = once(i);
    samples[i] = Number(process.hrtime.bigint() - start);
  }
  if (!TOKEN_SHAPE.test(last)) throw new Error('the token has the wrong shape');
  const startedAt = new Date();
  const result = {
    meta: {
      official: false,
      what: 'TokenMint.mint of the Privacy Service (HMAC-SHA256, PSEU- + 8 hex), in process, throwaway keys, no I/O',
      date: startedAt.toISOString(),
      commit: git(['rev-parse', 'HEAD']),
      treeClean: git(['status', '--porcelain', '--', '.', ':(exclude)docs/hasil']).length === 0,
      iterations: o.iterations,
      warmup: o.warmup,
      timer: 'process.hrtime.bigint per call (its own cost is inside every sample)',
      nodeVersion: process.version,
      cpuModel: os.cpus()[0]?.model,
      cpus: os.cpus().length,
      totalMemoryGB: +(os.totalmem() / GB).toFixed(2),
      freeMemoryGB: +(os.freemem() / GB).toFixed(2),
      os: `${os.type()} ${os.release()}`,
    },
    tokenIssue: summarize(samples),
  };
  const outDir = path.join(root, 'docs', 'hasil', 'kinerja', 'kesiapan');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `token-microbench-${startedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${path.relative(root, file)}\n`);
}

if (require.main === module) main();
module.exports = { percentile, summarize, TOKEN_SHAPE };
