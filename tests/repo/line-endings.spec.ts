import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Scripts run on Linux (CI, WSL) as well as on Windows. A carriage return in a shell script makes a Linux bash fail
// with "syntax error near unexpected token `$'{\r''", while Git Bash on Windows ignores it: the same file passed on one
// machine and failed on another. With core.autocrlf=true Git writes CRLF into the working tree unless told otherwise.
const root = join(__dirname, '..', '..');

const git = (...args: string[]): string[] => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.split('\n').filter((line) => line !== '');
};

describe('M0-LE scripts keep LF line endings on every machine', () => {
  const shellScripts = git('ls-files', '*.sh');
  const scriptFiles = git(
    'ls-files',
    '*.sh',
    '*.sql',
    '*.ps1',
    '*.mjs',
    'scripts/**',
    'tools/*/scripts/**',
  );

  it('M0-LE the repository has shell scripts to check (this test is not vacuous)', () => {
    expect(shellScripts).toContain('scripts/ci/bootstrap-twice.sh');
  });

  it('M0-LE no shell script in the working tree contains a carriage return', () => {
    const withCr = shellScripts.filter((file) =>
      readFileSync(join(root, file), 'utf8').includes('\r'),
    );
    expect(withCr).toEqual([]);
  });

  it('M0-LE .gitattributes makes Git write LF for shell scripts and for the script folders, whatever autocrlf says', () => {
    for (const file of scriptFiles) {
      const attributes = git('check-attr', 'eol', 'text', '--', file).join(' ');
      // On failure the message names the file.
      expect([file, attributes]).toEqual([file, expect.stringContaining('eol: lf')]);
      expect(attributes).toContain('eol: lf');
      expect(attributes).toContain('text: set');
    }
  });

  it('M0-LE a new shell script is covered too, not only the ones that exist today', () => {
    const attributes = git(
      'check-attr',
      'eol',
      '--',
      'scripts/somewhere/new-script.sh',
      'tools/x/scripts/y.mjs',
    ).join(' ');
    expect(attributes.match(/eol: lf/g)).toHaveLength(2);
  });
});
