'use strict';
// Development CA and server certificates for the TLS path Gateway -> Privacy Service (DK-03, NFR-06). Everything is
// made with the `openssl` program (never with code of ours: the project rules forbid writing cryptography), into a folder that
// is git-ignored; no key is printed or committed. `openssl ca` is used for every certificate because it is the one
// command that can set the validity dates, which the tests need for an expired certificate.
//
//   node scripts/docker/tls.cjs            makes secrets/docker/ca/ca.key (never mounted), secrets/docker/tls_ca.crt,
//                                          tls_privacy.crt and tls_privacy.key; keeps files that exist ('wx' semantics)
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const GIT_FOR_WINDOWS = ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];

/** The openssl program: OPENSSL_BIN, then PATH, then the one that comes with Git for Windows. */
let resolved;
function opensslBinary() {
  if (resolved) return resolved;
  const candidates = [process.env['OPENSSL_BIN'], 'openssl', ...GIT_FOR_WINDOWS].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (probe.status === 0) return (resolved = candidate);
  }
  throw new Error('openssl was not found: put it on PATH or set OPENSSL_BIN');
}

function run(args, cwd) {
  const result = spawnSync(opensslBinary(), args, { cwd, encoding: 'utf8' });
  // The message of openssl never carries key material; still, only its first lines are kept.
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(result.stderr || '').split('\n').slice(0, 3).join(' ')}`);
}

/** `YYYYMMDDHHMMSSZ` in UTC, the form `openssl ca -startdate/-enddate` takes. */
function opensslDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

const slash = (p) => p.split(path.sep).join('/');

/** Makes a CA (EC P-256) in `dir`: ca.key and ca.crt. */
function issueCa(dir, { commonName = 'PrivPay development CA', days = 825 } = {}) {
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'ca.key');
  const crt = path.join(dir, 'ca.crt');
  run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  run(['req', '-x509', '-new', '-key', key, '-sha256', '-days', String(days), '-subj', `/CN=${commonName}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', crt]);
  return { key, crt };
}

/**
 * Issues a server certificate signed by `ca` (the object `issueCa` returned) into `dir` as `<name>.key` and
 * `<name>.crt`. `dnsNames` are the names the certificate is valid for; `notBefore`/`notAfter` are Dates.
 */
function issueServer(dir, ca, { name, dnsNames, ipAddresses = [], notBefore, notAfter }) {
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), 'privpay-ca-'));
  try {
    const key = path.join(dir, `${name}.key`);
    const crt = path.join(dir, `${name}.crt`);
    const csr = path.join(work, 'server.csr');
    run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    run(['req', '-new', '-key', key, '-subj', `/CN=${dnsNames[0]}`, '-out', csr]);
    writeFileSync(path.join(work, 'index.txt'), '');
    writeFileSync(path.join(work, 'serial'), '01\n');
    writeFileSync(path.join(work, 'ext.cnf'),
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${[...dnsNames.map((n) => `DNS:${n}`), ...ipAddresses.map((a) => `IP:${a}`)].join(',')}\n`);
    writeFileSync(path.join(work, 'ca.cnf'),
      `[ca]\ndefault_ca=c\n[c]\ndatabase=${slash(path.join(work, 'index.txt'))}\nserial=${slash(path.join(work, 'serial'))}\nnew_certs_dir=${slash(work)}\ndefault_md=sha256\nunique_subject=no\npolicy=p\n[p]\ncommonName=supplied\n`);
    run(['ca', '-batch', '-notext', '-config', slash(path.join(work, 'ca.cnf')), '-cert', slash(ca.crt), '-keyfile', slash(ca.key),
      '-startdate', opensslDate(notBefore), '-enddate', opensslDate(notAfter), '-extfile', slash(path.join(work, 'ext.cnf')),
      '-in', slash(csr), '-out', slash(crt)]);
    return { key, crt };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The files the Compose stack mounts; existing files are kept, so a second run changes nothing. Two sets, each all or
 * nothing: the CA with the Privacy Service certificate (DK-03), and the Kong edge certificate (DK-02a). A stack made
 * before DK-02a gets only the Kong pair, signed by the CA it already has.
 */
function makeComposeTls(secretsDir, out = () => undefined) {
  const caDir = path.join(secretsDir, 'ca');
  const base = {
    caKey: path.join(caDir, 'ca.key'),
    caCrt: path.join(secretsDir, 'tls_ca.crt'),
    crt: path.join(secretsDir, 'tls_privacy.crt'),
    key: path.join(secretsDir, 'tls_privacy.key'),
  };
  const kong = {
    crt: path.join(secretsDir, 'tls_kong.crt'),
    key: path.join(secretsDir, 'tls_kong.key'),
  };
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const presentOf = (set) => Object.values(set).filter((file) => existsSync(file));
  // A CA and a certificate only fit together as a set; never overwrite half of one.
  for (const set of [base, kong]) {
    const present = presentOf(set);
    if (present.length > 0 && present.length < Object.keys(set).length) {
      throw new Error(`incomplete TLS set in ${secretsDir}: remove the tls_* files and ca/ to make a new one`);
    }
  }
  const needBase = presentOf(base).length === 0;
  const needKong = presentOf(kong).length === 0;
  if (!needBase && !needKong) {
    for (const file of [...presentOf(base), ...presentOf(kong)]) out(`kept    ${file}`);
    return false;
  }
  if (needBase && !needKong) {
    throw new Error(`incomplete TLS set in ${secretsDir}: the Kong files exist without the CA; remove the tls_* files and ca/`);
  }
  const work = mkdtempSync(path.join(tmpdir(), 'privpay-tls-'));
  const created = [];
  try {
    const now = new Date();
    const validity = { notBefore: new Date(now.getTime() - 3600_000), notAfter: new Date(now.getTime() + 365 * 86_400_000) };
    let ca;
    if (needBase) {
      ca = issueCa(work);
      // The service name on the `privacy` network is what callers connect to; nothing else is valid.
      const privacy = issueServer(work, ca, { name: 'privacy', dnsNames: ['privacy-service'], ...validity });
      mkdirSync(caDir, { recursive: true, mode: 0o700 });
      copyFileSync(ca.key, base.caKey);
      copyFileSync(ca.crt, base.caCrt);
      copyFileSync(privacy.crt, base.crt);
      // Readable inside the folder so the non-root user of the container can read the bind-mounted copy (Linux).
      copyFileSync(privacy.key, base.key);
      created.push(...Object.values(base));
    } else {
      // openssl reads the CA key; it is never printed or copied.
      ca = { key: base.caKey, crt: base.caCrt };
    }
    if (needKong) {
      // The names a client of the edge may use: the Compose service name, and the loopback names of the published port.
      const edge = issueServer(work, ca, {
        name: 'kong',
        dnsNames: ['kong', 'localhost'],
        ipAddresses: ['127.0.0.1'],
        ...validity,
      });
      copyFileSync(edge.crt, kong.crt);
      copyFileSync(edge.key, kong.key);
      created.push(kong.crt, kong.key);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const file of created) out(`created ${file}`);
  return true;
}

/** Compose secret name -> file in the secrets folder (the CA key is not here: nothing mounts it). */
const TLS_SECRETS = Object.freeze({
  tls_ca_crt: 'tls_ca.crt',
  tls_privacy_crt: 'tls_privacy.crt',
  tls_privacy_key: 'tls_privacy.key',
  tls_kong_crt: 'tls_kong.crt',
  tls_kong_key: 'tls_kong.key',
});

module.exports = { issueCa, issueServer, makeComposeTls, opensslBinary, TLS_SECRETS };

if (require.main === module) {
  const dir = process.env['DOCKER_SECRETS_DIR'] ?? path.join(__dirname, '..', '..', 'secrets', 'docker');
  try {
    makeComposeTls(dir, (line) => process.stdout.write(`${line}\n`));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'error'}\n`);
    process.exitCode = 1;
  }
}
