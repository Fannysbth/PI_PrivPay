import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// SECURITY.md section 3: nothing under secrets/ except the README is ever committed. --no-index asks "does a pattern
// ignore this path?" even for paths that are already tracked, which plain `git check-ignore` never reports.
const root = join(__dirname, '..', '..');

const ignored = (path: string): boolean => {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: root });
  if (result.status !== 0 && result.status !== 1) throw new Error('git check-ignore failed');
  return result.status === 0;
};

describe('M0-GI .gitignore keeps secrets out and the documented files in', () => {
  it.each(['secrets/README.md', 'secrets/.gitkeep', '.env.example', '.env.test.example'])(
    'M0-GI %s is not ignored, so it can be committed',
    (path) => {
      expect(ignored(path)).toBe(false);
    },
  );

  it.each([
    'secrets/privacy_db_password',
    'secrets/nested/pseudonym_hmac_secret',
    'secrets/README.md.bak',
    '.env',
    '.env.test',
    '.env.local',
    'id_rsa',
    'server.pem',
    'node_modules/pg/index.js',
    'packages/common/dist/index.js',
    'gitleaks-report.json',
    'PROMPT_AWAL.md',
    'PROMPT_TAMBAHAN.md',
  ])('M0-GI %s is ignored', (path) => {
    expect(ignored(path)).toBe(true);
  });

  it('M0-GI nothing under secrets/ except the README is tracked', () => {
    const tracked = spawnSync('git', ['ls-files', 'secrets'], { cwd: root, encoding: 'utf8' });
    expect(tracked.stdout.split('\n').filter((line) => line !== '')).toEqual(['secrets/README.md']);
  });

  it('M0-GI the file holds only patterns and comments, with no leftover shell command', () => {
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
      expect(line).not.toMatch(/Set-Content|^@'|^'@/);
    }
  });

  it('M0-GI no pattern ignores the whole secrets/ directory, which would void the exceptions below it', () => {
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').replace(/\r\n/g, '\n').split('\n');
    expect(lines).not.toContain('secrets/');
    expect(lines).not.toContain('/secrets/');
    expect(lines).toContain('secrets/*');
  });

  it('M0-GI each pattern appears once', () => {
    const patterns = readFileSync(join(root, '.gitignore'), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    const repeated = patterns.filter((line, index) => patterns.indexOf(line) !== index);
    expect(repeated).toEqual([]);
  });
});
