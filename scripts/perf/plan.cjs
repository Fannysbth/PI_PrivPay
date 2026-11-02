'use strict';
// M7-A: the parts of the performance runner that are decisions, kept apart from the part that talks to Docker so a static test
// can read them (tests/performance/k6-harness.spec.ts). Nothing here starts a process.

/** The pinned load generator (grafana/k6 1.3.0). A digest, not a tag: the same bytes in every run (no install on the host). */
const K6_IMAGE = 'grafana/k6@sha256:3ddc8b1a33a2c3d8edc6e99b6a762ae36cba08788463458f5e6a7703e14eb77d';

/** Metodologi D.4: one level of load; PRD 18.4 and the Metodologi give the official parameters. */
const OFFICIAL = Object.freeze({ vus: 100, warmup: '60s', duration: '300s', repeats: 5, thinkMs: 0 });

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
    p.thinkMs === OFFICIAL.thinkMs
  );
}

/**
 * The arguments after `docker` for one k6 run. The password of the test customers is a mounted FILE (never an argument or an
 * environment value of the host command); the development CA is mounted and named by SSL_CERT_FILE so TLS stays verified.
 */
function k6DockerArgs(o) {
  return [
    'run', '--rm', '--name', o.containerName, '--network', o.network,
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
    '-e', `THINK_MS=${String(o.thinkMs)}`,
    '-e', `RUN_BASE=${String(o.runBase)}`,
    '-e', 'BASE_URL=https://kong:8443',
    '-e', 'IDP_URL=http://keycloak:8080',
    '/script/mixed.k6.js',
  ];
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

module.exports = { K6_IMAGE, OFFICIAL, SERVICE_LABEL, alternation, seconds, isOfficialShape, k6DockerArgs, resourceQueries };
