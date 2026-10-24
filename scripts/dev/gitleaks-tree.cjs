'use strict';
// `pnpm secret-scan:tree`: gitleaks over the working tree as it would be committed, i.e. the tracked files plus the
// untracked files that are NOT git-ignored. A plain `gitleaks detect --no-git` also reads the git-ignored secrets/ folder,
// where the Docker TLS key (DK-03) is a PEM private key by nature and trips the default rule; it never reaches git, so it
// is not what this check is for. No allowlist is added: the same .gitleaks.toml applies to the same relative paths.
const { spawnSync } = require('node:child_process');
const { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (listed.status !== 0) {
  process.stderr.write('git ls-files failed\n');
  process.exit(2);
}

// The scan above leaves secrets/ out only because git ignores it: if that stops being true, the check is meaningless
// and (worse) key files could be committed, so the gate fails.
const ignored = spawnSync('git', ['check-ignore', '-q', 'secrets/docker/tls_privacy.key', 'secrets/probe'], { cwd: root });
if (ignored.status !== 0) {
  process.stderr.write('secrets/ is not git-ignored: refusing to scan\n');
  process.exit(2);
}

const work = mkdtempSync(path.join(tmpdir(), 'privpay-tree-'));
let status = 2;
try {
  for (const relative of listed.stdout.split('\0').filter(Boolean)) {
    // Symlinks, submodules and directories are not content to scan.
    try {
      if (!lstatSync(path.join(root, relative)).isFile()) continue;
    } catch {
      continue;
    }
    const target = path.join(work, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    try {
      copyFileSync(path.join(root, relative), target);
    } catch (error) {
      // A tracked file deleted in the working tree is simply not there to scan.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const binary = process.env['GITLEAKS_BIN'] ?? path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WinGet', 'Links', 'gitleaks.exe');
  const run = (command) => spawnSync(command, ['detect', '--no-git', '--redact', ...(process.env['GITLEAKS_REPORT'] ? ['--report-format', 'json', '--report-path', process.env['GITLEAKS_REPORT']] : []), '--config', path.join(root, '.gitleaks.toml'), '--source', '.'], { stdio: 'inherit', cwd: work });
  let result = run(binary);
  if (result.error) result = run('gitleaks');
  status = result.status ?? 2;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = status;
