import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitInfo } from './commit-info';

// M6 measurements record "tree bersih" in their result files. The result files themselves (docs/hasil) are written by the
// run, so the first measurement must not make the next one look dirty; any other change must still count.
const git = (cwd: string, args: string[]): void => {
  const done = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

describe('M6 commitInfo', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'privpay-commit-info-'));
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, 'a.txt'), 'a');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('M6 a clean tree is not dirty and reports the commit', () => {
    const info = commitInfo(dir);
    expect(info.dirty).toBe(false);
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('M6 files written under docs/hasil do not make the tree dirty', () => {
    mkdirSync(join(dir, 'docs', 'hasil'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'hasil', 'e-s-proposed.json'), '{}');
    expect(commitInfo(dir).dirty).toBe(false);
  });

  it('M6 an untracked file elsewhere makes the tree dirty', () => {
    writeFileSync(join(dir, 'b.txt'), 'b');
    expect(commitInfo(dir).dirty).toBe(true);
  });

  it('M6 outside a git work tree it throws instead of reporting a clean tree with no commit', () => {
    const plain = mkdtempSync(join(tmpdir(), 'privpay-not-a-repo-'));
    try {
      expect(() => commitInfo(plain)).toThrow(/git/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('M6 a modified tracked file makes the tree dirty', () => {
    writeFileSync(join(dir, 'a.txt'), 'changed');
    expect(commitInfo(dir).dirty).toBe(true);
  });
});
