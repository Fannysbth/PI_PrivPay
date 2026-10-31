'use strict';
// `pnpm docker:net-check <proposed|baseline>`: checks the three networks and the TLS path on the RUNNING stack (DK-03,
// NFR-06). Every probe runs inside a container with that container's own Node, so it sees exactly what the service sees.
// "reach" means a TCP connection opens; "refused" means it does not (no route, no DNS name, or closed) within 2 seconds.
// Exit code 0 only if every check came out as expected. Nothing here prints a secret or a certificate.
const { spawnSync } = require('node:child_process');
const { composeArgs, MODES } = require('./compose.cjs');

const tcpProbe = (host, port) =>
  `const s=require('net').connect({host:${JSON.stringify(host)},port:${port},timeout:2000});` +
  `s.on('connect',()=>{console.log('reach');process.exit(0)});` +
  `s.on('timeout',()=>{console.log('refused');process.exit(0)});` +
  `s.on('error',()=>{console.log('refused');process.exit(0)});`;

/** Prints `status <n>` or `error <code>` for a request made with Node's global fetch, as the services make them. */
const fetchProbe = (url) =>
  `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(3000)}).then(r=>console.log('status '+r.status),e=>console.log('error '+((e.cause&&e.cause.code)||e.code||e.name)))`;

/** Same, but to the address behind `host`, so the name on the certificate cannot match. */
const fetchByAddressProbe = (host, port) =>
  `require('dns').promises.lookup(${JSON.stringify(host)}).then(a=>fetch('https://'+a.address+':${port}/health',{signal:AbortSignal.timeout(3000)})).then(r=>console.log('status '+r.status),e=>console.log('error '+((e.cause&&e.cause.code)||e.code||e.name)))`;

function inside(mode, service, script, env = {}) {
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const args = composeArgs(mode, ['exec', '-T', ...flags, service, 'node', '-e', script]);
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) return `exec failed (${String(result.status)})`;
  return result.stdout.trim();
}

function checks(mode) {
  const list = [
    // Business zone: the normal paths work.
    ['gateway reaches transaction-service', 'gateway', tcpProbe('transaction-service', 4002), 'reach'],
    ['transaction-service reaches pg-transaction', 'transaction-service', tcpProbe('pg-transaction', 5432), 'reach'],
    ['no service has a route to the Internet (business is internal)', 'fraud-service', tcpProbe('1.1.1.1', 443), 'refused'],
    // The edge (DK-02a): Kong is the only way in; TLS only, no admin API.
    ['gateway adapter is reached through Kong: kong listens on 8443 (TLS)', 'gateway', tcpProbe('kong', 8443), 'reach'],
    ['kong has no plain HTTP listener (8000)', 'gateway', tcpProbe('kong', 8000), 'refused'],
    ['kong has no admin API (8001, 8444)', 'gateway', tcpProbe('kong', 8001), 'refused'],
    ['kong status listener (8100, for Prometheus) is on the internal network only', 'gateway', tcpProbe('kong', 8100), 'reach'],
  ];

  if (mode === 'proposed') {
    list.push(
      ['gateway reaches privacy-service over TLS (CA verified)', 'gateway', fetchProbe('https://privacy-service:4001/health'), 'status 200'],
      ['transaction-service reaches privacy-service over TLS', 'transaction-service', fetchProbe('https://privacy-service:4001/health'), 'status 200'],
      ['plain HTTP to privacy-service is refused', 'gateway', fetchProbe('http://privacy-service:4001/health'), /^error /],
      ['a caller without the dev CA rejects the certificate', 'gateway', fetchProbe('https://privacy-service:4001/health'), /^error (UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)$/, { NODE_EXTRA_CA_CERTS: '/nonexistent.pem' }],
      ['a certificate for another name is rejected (connect by address)', 'gateway', fetchByAddressProbe('privacy-service', 4001), 'error ERR_TLS_CERT_ALTNAME_INVALID'],
      ['fraud-service has no route to privacy-service', 'fraud-service', tcpProbe('privacy-service', 4001), 'refused'],
      ['fraud-service has no route to pg-privacy', 'fraud-service', tcpProbe('pg-privacy', 5432), 'refused'],
      ['sms-simulator has no route to privacy-service', 'sms-simulator', tcpProbe('privacy-service', 4001), 'refused'],
      ['bank-simulator has no route to pg-privacy', 'bank-simulator', tcpProbe('pg-privacy', 5432), 'refused'],
      ['privacy-service has no route to pg-transaction (other zone)', 'privacy-service', tcpProbe('pg-transaction', 5432), 'refused'],
      ['privacy-service has no route to fraud-service (business only)', 'privacy-service', tcpProbe('fraud-service', 4003), 'refused'],
      ['privacy-service has no route to kong (edge is not in the privacy zone)', 'privacy-service', tcpProbe('kong', 8443), 'refused'],
      ['privacy-service reaches its own database', 'privacy-service', tcpProbe('pg-privacy', 5432), 'reach'],
    );
  } else {
    list.push(
      ['no privacy-service exists in baseline', 'gateway', tcpProbe('privacy-service', 4001), 'refused'],
      ['no pg-privacy exists in baseline', 'transaction-service', tcpProbe('pg-privacy', 5432), 'refused'],
    );
  }
  return list;
}

function main() {
  const [mode] = process.argv.slice(2);
  if (!MODES.includes(mode)) {
    process.stderr.write('usage: net-check.cjs <proposed|baseline>\n');
    return 2;
  }
  let failed = 0;
  for (const [label, service, script, expected, env] of checks(mode)) {
    const got = inside(mode, service, script, env);
    const ok = expected instanceof RegExp ? expected.test(got) : got === expected;
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   (got: ${got})`}\n`);
  }
  process.stdout.write(failed === 0 ? 'all checks passed\n' : `${String(failed)} check(s) failed\n`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
