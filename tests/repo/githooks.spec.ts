import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

// DK-06 (decision of Fanny, 2026-11-01): a pre-commit hook that runs `gitleaks protect --staged`, without a new dependency
// (a folder .githooks and core.hooksPath). It fails closed: no gitleaks, no commit. The synthetic secrets below are made at
// run time, never written in the repository.
const root = join(__dirname, '..', '..');
const hookDir = join(root, '.githooks');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// The environment of the child: no GIT_* variable of an outer repository (a hook or wrapper that runs the tests sets them), and a
// PATH given here replaces the PATH of this process whatever its case (Windows says `Path`).
function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) continue;
    if (key.toUpperCase() === 'PATH' && extra['PATH'] !== undefined) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: childEnv(env) });

/** A throwaway repository that uses the real hook of this repository and the real gitleaks configuration. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'privpay-hook-'));
  dirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Hook Test']);
  git(dir, ['config', 'user.email', 'hook@example.test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', hookDir]);
  copyFileSync(join(root, '.gitleaks.toml'), join(dir, '.gitleaks.toml'));
  return dir;
}
const stage = (dir: string, name: string, text: string) => {
  writeFileSync(join(dir, name), text);
  git(dir, ['add', name]);
};
const commit = (dir: string, env: NodeJS.ProcessEnv = {}) =>
  git(dir, ['commit', '-q', '-m', 'test'], env);
const syntheticSecret = (): string =>
  `synthetic_api_key = "${randomBytes(30).toString('base64url')}"\n`;

function findGitleaks(): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const name of ['gitleaks', 'gitleaks.exe'])
      if (dir !== '' && existsSync(join(dir, name))) return join(dir, name);
  }
  const winget = join(
    process.env['LOCALAPPDATA'] ?? '',
    'Microsoft',
    'WinGet',
    'Links',
    'gitleaks.exe',
  );
  return process.env['LOCALAPPDATA'] !== undefined && existsSync(winget) ? winget : undefined;
}

describe('DK-06 the pre-commit hook (gitleaks protect --staged)', () => {
  // Several git and gitleaks processes per test; the default 5 s of Jest is too tight on a loaded machine.
  jest.setTimeout(60_000);
  it('DK-06 .githooks/pre-commit is tracked, executable in the index, and uses LF', () => {
    const entry = spawnSync('git', ['ls-files', '-s', '.githooks/pre-commit'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout;
    expect(entry).toMatch(/^100755 /);
    expect(readFileSync(join(hookDir, 'pre-commit'), 'utf8')).not.toContain('\r');
  });

  it('DK-06 it is fail-closed: without gitleaks no commit is made', () => {
    const dir = scratchRepo();
    stage(dir, 'plain.txt', 'nothing secret here\n');
    // The PATH of this process without any directory that holds gitleaks, so that sh and git are still found.
    const without = (process.env['PATH'] ?? '')
      .split(delimiter)
      .filter(
        (entry) => !['gitleaks', 'gitleaks.exe'].some((name) => existsSync(join(entry, name))),
      )
      .join(delimiter);
    const result = commit(dir, { PATH: without, LOCALAPPDATA: '', PRIVPAY_GITLEAKS: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('gitleaks');
  });

  it('DK-06 it calls `gitleaks protect --staged` with the shared configuration and passes its exit code on', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'privpay-stub-'));
    dirs.push(stubDir);
    const log = join(stubDir, 'args.txt');
    const stub = join(stubDir, 'gitleaks-stub');
    writeFileSync(
      stub,
      `#!/bin/sh\necho "$@" > "${log.split(sep).join('/')}"\nexit "\${STUB_EXIT:-0}"\n`,
    );
    chmodSync(stub, 0o755);
    const refused = scratchRepo();
    stage(refused, 'a.txt', 'a\n');
    expect(
      commit(refused, { PRIVPAY_GITLEAKS: stub.split(sep).join('/'), STUB_EXIT: '1' }).status,
    ).not.toBe(0);
    const args = readFileSync(log, 'utf8');
    expect(args).toContain('protect');
    expect(args).toContain('--staged');
    expect(args).toContain('--config');
    expect(args).toContain('.gitleaks.toml');
    const accepted = scratchRepo();
    stage(accepted, 'a.txt', 'a\n');
    expect(
      commit(accepted, { PRIVPAY_GITLEAKS: stub.split(sep).join('/'), STUB_EXIT: '0' }).status,
    ).toBe(0);
  });

  it('DK-06 with the real gitleaks a synthetic secret is refused and a clean file is committed', () => {
    const bin = findGitleaks();
    if (bin === undefined)
      throw new Error(
        'gitleaks is required (CLAUDE.md, Perintah): install it, the hook is fail-closed',
      );
    const env = { PRIVPAY_GITLEAKS: bin.split(sep).join('/') };
    const dirty = scratchRepo();
    stage(dirty, 'config.txt', syntheticSecret());
    const refused = commit(dirty, env);
    expect(refused.status).not.toBe(0);
    expect(git(dirty, ['log', '--oneline']).status).not.toBe(0); // no commit was made
    const clean = scratchRepo();
    stage(clean, 'note.txt', 'a plain note\n');
    expect(commit(clean, env).status).toBe(0);
  });

  it('DK-06 the install command is written down (package script and README)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['hooks:install']).toBe('git config core.hooksPath .githooks');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('hooks:install');
  });
});
