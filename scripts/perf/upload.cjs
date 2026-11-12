'use strict';
// M7-E (N-61, option A): hand-over of k6-summary.json from the second laptop (B) to the runner (A) without a shared folder.
// A temporary HTTP listener on A accepts exactly ONE PUT; B sends it with the last part of the single command the runner prints.
// Only node:http and node:crypto (no dependency). The body is metrics only (no personal data), the channel has no TLS: the exposure
// is limited by the single bind address, the peer address, a one-time random token, a 1 MiB cap and a timeout (RUNBOOK-dua-mesin.md).
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const plan = require('./plan.cjs');

const GB = 1024 ** 3;
const MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_FREE_BYTES = 3.5 * GB;
const MEMORY_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_PORT = 4444;
const UPLOAD_PATH = '/upload';
const DEFAULT_B_DIR = 'C:\\k6test';

/** Why a parsed summary is not what the runner expects (undefined = fine). The messages go to B, so they never echo the content. */
function validateSummary(value, mode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'summary must be a JSON object';
  if (value.mode !== mode) return 'summary is for another mode';
  if (typeof value.endedAt !== 'string' || Number.isNaN(Date.parse(value.endedAt))) return 'summary has no valid endedAt';
  const metrics = value.metrics;
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) return 'summary has no metrics';
  if (!Object.keys(metrics).some((k) => k.startsWith('http_reqs'))) return 'summary has no http_reqs metric';
  return undefined;
}

const sameSecret = (a, b) => {
  // Digests have equal length, so timingSafeEqual never throws and the comparison does not leak the length of the token.
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
};
const normalizeAddress = (a) => String(a ?? '').replace(/^::ffff:/i, '');

/**
 * Starts the listener. `host` is required and is the ONLY address it binds to (never 0.0.0.0 or a wildcard; the runner validates it
 * as a private IPv4 first). Resolves when listening. `done` resolves once with `received`, `timeout` or `closed`.
 * `timer` and `now` can be injected so tests need no real sleep.
 */
async function startUploadListener(o) {
  if (typeof o.host !== 'string' || o.host === '' || o.host === '0.0.0.0' || o.host === '::') throw new RangeError('upload host must be one explicit address');
  const timer = o.timer ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
  const now = o.now ?? (() => new Date());
  const token = crypto.randomBytes(24).toString('hex');
  let used = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const server = http.createServer();
  server.requestTimeout = 30000; // a stalled sender cannot hold the listener (the default is 5 minutes)
  server.headersTimeout = 10000;

  const reply = (res, status, text) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  let handle;
  const shutdown = (status, extra = {}) => {
    if (handle !== undefined) timer.clear(handle);
    server.close();
    // After an upload the answer is sent with Connection: close, so the socket ends after the answer is flushed (destroying it now could
    // reset the 200 on its way to B). Any other end drops every open connection at once.
    if (status !== 'received') setImmediate(() => server.closeAllConnections());
    finish({ status, ...extra });
  };

  server.on('request', (req, res) => {
    // Order matters: cheap checks that need no body come first, so an unauthorized sender is never read.
    if (normalizeAddress(req.socket.remoteAddress) !== o.peerIp) return reply(res, 403, 'forbidden');
    if (req.method !== 'PUT') { req.resume(); return reply(res, 405, 'method not allowed'); }
    // The token is a bearer credential in a header, never part of the URL (CLAUDE.md: no secret in a URL or query). The path is fixed.
    if ((req.url ?? '').split('?')[0] !== UPLOAD_PATH) { req.resume(); return reply(res, 404, 'not found'); }
    const match = /^Bearer ([0-9a-f]{48})$/.exec(String(req.headers.authorization ?? ''));
    if (match === null || !sameSecret(match[1], token)) { req.resume(); return reply(res, 401, 'unauthorized'); }
    if (used) { req.resume(); return reply(res, 409, 'already received'); }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BYTES) { req.resume(); return reply(res, 413, 'body too large'); }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BYTES) { tooBig = true; chunks.length = 0; reply(res, 413, 'body too large'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, 'body is not valid JSON'); }
      const problem = validateSummary(parsed, o.expectedMode);
      if (problem !== undefined) return reply(res, 422, problem);
      if (used) return reply(res, 409, 'already received'); // two valid uploads in flight: the first one wins
      used = true;
      // Write beside the target and rename, so the runner never reads a half file.
      const part = `${o.outFile}.part`;
      try {
        fs.writeFileSync(part, Buffer.concat(chunks));
        fs.renameSync(part, o.outFile);
      } catch {
        used = false; // a disk problem must not kill the runner or burn the token: B can send again
        return reply(res, 500, 'could not store the summary');
      }
      const receivedAt = now().toISOString();
      reply(res, 200, 'received');
      shutdown('received', { receivedAt });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: o.host, port: o.port, exclusive: true }, () => { server.off('error', reject); resolve(); });
  });
  handle = timer.set(() => shutdown('timeout'), o.timeoutMs);
  const address = server.address();
  return {
    token,
    port: address.port,
    address: address.address,
    done,
    close: async () => {
      if (server.listening) shutdown('closed');
      await done;
    },
  };
}

/** The private IPv4 of B, the port, the timeout and the folder on B, all validated; the folder goes into a command, so it is strict. */
function uploadSettings(o) {
  let peerIp;
  try { peerIp = plan.assertLanIp(o.peerIp ?? ''); } catch { throw new RangeError('--peer-ip must be the private IPv4 address of the second laptop (10/8, 172.16/12 or 192.168/16)'); }
  const raw = o.env?.SUMMARY_UPLOAD_PORT;
  const port = raw === undefined || raw === '' ? DEFAULT_PORT : Number(raw);
  const kong = Number(o.env?.KONG_LAN_PORT ?? 4443);
  const idp = Number(o.env?.IDP_LAN_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === kong || port === idp) throw new RangeError('SUMMARY_UPLOAD_PORT must be a whole number from 1024 to 65535, not the Kong or Keycloak port');
  const timeoutMs = o.timeout === undefined ? DEFAULT_TIMEOUT_MS : plan.seconds(o.timeout) * 1000;
  const bDir = o.bDir ?? DEFAULT_B_DIR;
  // Letters, digits, dot, dash, underscore and backslash only: no space, quote, bracket or semicolon can reach the PowerShell command.
  if (!/^[A-Za-z]:\\[A-Za-z0-9_.\\-]*[A-Za-z0-9_.-]$/.test(bDir) || bDir.includes('..')) throw new RangeError('--b-dir must be an absolute Windows folder such as C:\\k6test (letters, digits, dot, dash, underscore)');
  return { peerIp, port, timeoutMs, bDir };
}

/**
 * ONE PowerShell line for B: remove an old summary, run k6 in the pinned image, then PUT the new summary to A. `;` runs the upload even
 * when k6 exits non-zero (a failed threshold still leaves a summary); a missing summary makes the upload fail loudly.
 */
function remoteCommand(o) {
  const out = `${o.bDir}\\out\\k6-summary.json`;
  return [
    `Remove-Item ${out} -ErrorAction SilentlyContinue`,
    `docker ${o.k6Args.join(' ')}`,
    `Invoke-RestMethod -Method Put -InFile ${out} -ContentType application/json -TimeoutSec 60 -Headers @{Authorization='Bearer ${o.token}'} -Uri http://${o.ip}:${String(o.port)}${UPLOAD_PATH}`,
  ].join('; ');
}

/** The k6 mounts on B under one folder; the same names as the runbook (ca.crt, password, script, out). */
function bPaths(bDir) {
  return { caFile: `${bDir}\\ca.crt`, passwordFile: `${bDir}\\password`, scriptDir: `${bDir}\\script`, outDir: `${bDir}\\out` };
}

/**
 * M7-E: free memory is read AFTER Docker Desktop is up, and the run waits (at most 5 minutes) for 3.5 GB. Injected `readFree`, `now`
 * and `sleep` keep it testable. `ok: false` carries a message; the figure is recorded in the result either way.
 */
async function waitForFreeMemory(o) {
  const minBytes = o.minBytes ?? MIN_FREE_BYTES;
  const maxMs = o.maxWaitMs ?? MEMORY_WAIT_MS;
  const pollMs = o.pollMs ?? 5000;
  const started = o.now();
  const gb = (bytes) => +(bytes / GB).toFixed(2);
  for (;;) {
    const free = o.readFree();
    const waitedSeconds = Math.round((o.now() - started) / 1000);
    if (free >= minBytes) return { ok: true, freeGB: gb(free), waitedSeconds };
    if (o.now() - started >= maxMs) {
      return { ok: false, freeGB: gb(free), waitedSeconds, message: `free memory is ${gb(free).toFixed(2)} GB after ${String(waitedSeconds)} s; the run needs ${gb(minBytes)} GB with Docker Desktop running. Close other programs (browser, IDE) and start again` };
    }
    await o.sleep(pollMs);
  }
}

module.exports = { DEFAULT_PORT, DEFAULT_TIMEOUT_MS, MAX_BYTES, MIN_FREE_BYTES, bPaths, remoteCommand, startUploadListener, uploadSettings, validateSummary, waitForFreeMemory };
