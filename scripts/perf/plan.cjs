'use strict';
// M7-A: the parts of the performance runner that are decisions, kept apart from the part that talks to Docker so a static test
// can read them (tests/performance/k6-harness.spec.ts). Nothing here starts a process.

/** The pinned load generator (grafana/k6 1.3.0). A digest, not a tag: the same bytes in every run (no install on the host). */
const K6_IMAGE = 'grafana/k6@sha256:3ddc8b1a33a2c3d8edc6e99b6a762ae36cba08788463458f5e6a7703e14eb77d';

/** Metodologi D.4: one level of load; PRD 18.4 and the Metodologi give the official parameters. */
/**
 * Two paces, never mixed in one run (M7-B). The Metodologi names closed-loop load and a fixed number of users but says nothing about
 * a pause; saturation (no pause) is the literal reading, realistic (a random pause of 0.5 to 1.5 s, in mixed.k6.js) the usual one.
 */
const PACES = Object.freeze(['saturation', 'realistic']);

const OFFICIAL = Object.freeze({ vus: 100, warmup: '60s', duration: '300s', repeats: 5, paces: PACES });

/** The paces a session runs: an official session runs both (each as its own set of alternating runs), any other one pace. */
function pacesFor(official, pace) {
  if (official) return [...PACES];
  if (!PACES.includes(pace)) throw new RangeError(`pace must be one of ${PACES.join(', ')}`);
  return [pace];
}

/** Modes alternate (baseline, proposed, baseline, ...) so a drift of the machine does not fall on one condition (Metodologi D.5). */
function alternation(repeats, first = 'baseline') {
  if (!Number.isInteger(repeats) || repeats < 1) throw new RangeError('repeats must be a positive integer');
  const second = first === 'baseline' ? 'proposed' : 'baseline';
  const order = [];
  for (let i = 0; i < repeats; i += 1) {
    order.push(first, second);
  }
  return order.map((mode, index) => ({ run: index + 1, mode }));
}

/** Seconds of a k6 duration such as 60s, 5m or 0s (the only units the runner accepts). */
function seconds(duration) {
  const match = /^(\d+)(s|m)$/.exec(duration);
  if (match === null) throw new RangeError(`duration must look like 60s or 5m, not ${duration}`);
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1);
}

/** A run is official only with the Metodologi parameters; anything else is a readiness run and says so in its file. */
function isOfficialShape(p) {
  return (
    p.vus === OFFICIAL.vus &&
    seconds(p.warmup) === seconds(OFFICIAL.warmup) &&
    seconds(p.duration) === seconds(OFFICIAL.duration) &&
    PACES.includes(p.pace)
  );
}

/**
 * The arguments after `docker` for one k6 run. The password of the test customers is a mounted FILE (never an argument or an
 * environment value of the host command); the development CA is mounted and named by SSL_CERT_FILE so TLS stays verified.
 */
function k6DockerArgs(o) {
  return [
    'run', '--rm', '--name', o.containerName, ...(o.network === undefined ? [] : ['--network', o.network]),
    '-e', 'SSL_CERT_FILE=/ca/ca.crt',
    '-v', `${o.caFile}:/ca/ca.crt:ro`,
    '-v', `${o.passwordFile}:/secret/customer_password:ro`,
    '-v', `${o.scriptDir}:/script:ro`,
    '-v', `${o.outDir}:/out`,
    K6_IMAGE,
    'run', '--quiet',
    '-e', `MODE=${o.mode}`,
    '-e', `VUS=${String(o.vus)}`,
    '-e', `WARMUP=${o.warmup}`,
    '-e', `DURATION=${o.duration}`,
    '-e', `PACE=${o.pace}`,
    '-e', `RUN_BASE=${String(o.runBase)}`,
    '-e', `BASE_URL=${o.baseUrl ?? 'https://kong:8443'}`,
    '-e', `IDP_URL=${o.idpUrl ?? 'http://keycloak:8080'}`,
    ...(o.kongAddr === undefined ? [] : ['-e', `KONG_ADDR=${o.kongAddr}`]),
    ...(o.idpAddr === undefined ? [] : ['-e', `IDP_ADDR=${o.idpAddr}`]),
    '/script/mixed.k6.js',
  ];
}

/** M7-D (N-61, option A): the one LAN address the stack is published on; a private IPv4 only (never 0.0.0.0, loopback or a name). */
function assertLanIp(ip) {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(ip);
  const p = m === null ? [] : m.slice(1).map(Number);
  const private4 = p.length === 4 && p.every((n) => n <= 255) && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168));
  if (!private4) throw new RangeError('PRIVPAY_LAN_IP must be one private IPv4 address (10/8, 172.16/12 or 192.168/16)');
  return ip;
}

/**
 * The addresses k6 maps the names to on the second machine (plain host:port values, so no JSON has to survive a shell). The names stay
 * `kong` and `keycloak`, so the Host header, the TLS name (the certificate covers `kong`) and the token issuer
 * (`http://keycloak:8080/realms/privpay`) are what they are inside the stack; only the address changes.
 */
function lanTarget(ip, kongPort, idpPort) {
  assertLanIp(ip);
  return { kongAddr: `${ip}:${String(kongPort)}`, idpAddr: `${ip}:${String(idpPort)}` };
}

/**
 * M7-E: with a remote k6 the CPU and memory window is read at k6.endedAt (B's clock). The lag is how long after that the summary reached A
 * (it includes the clock difference of the two laptops); beyond 30 s either way the window cannot be trusted and the file says so.
 */
const RESOURCE_LAG_LIMIT_SECONDS = 30;
function resourceWindow(lagSeconds) {
  return { reliable: Number.isFinite(lagSeconds) && Math.abs(lagSeconds) <= RESOURCE_LAG_LIMIT_SECONDS, limitSeconds: RESOURCE_LAG_LIMIT_SECONDS };
}

const SERVICE_LABEL = 'container_label_com_docker_compose_service';

/** PromQL for CPU (cores, mean) and memory (peak working set) per container over the last `windowSeconds`. */
function resourceQueries(windowSeconds) {
  const selector = `{${SERVICE_LABEL}!=""}`;
  const window = `${String(windowSeconds)}s`;
  return {
    cpuCoresMean: `avg_over_time((sum by (${SERVICE_LABEL}) (rate(container_cpu_usage_seconds_total${selector}[30s])))[${window}:10s])`,
    memoryBytesPeak: `max_over_time((sum by (${SERVICE_LABEL}) (container_memory_working_set_bytes${selector}))[${window}:10s])`,
    memoryBytesMean: `avg_over_time((sum by (${SERVICE_LABEL}) (container_memory_working_set_bytes${selector}))[${window}:10s])`,
  };
}

/** M7-D: 5xx answers counted by each service since it started (a fresh stack per run). Timeouts and retries are not metered. */
function errorQueries() {
  return { http5xxByInstance: 'sum by (instance) (privpay_http_requests_total{status=~"5.."})' };
}

module.exports = { resourceWindow, assertLanIp, lanTarget, errorQueries, K6_IMAGE, OFFICIAL, PACES, pacesFor, SERVICE_LABEL, alternation, seconds, isOfficialShape, k6DockerArgs, resourceQueries };
