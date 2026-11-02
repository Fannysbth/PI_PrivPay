import { spawnSync } from 'node:child_process';

/**
 * The commit a measurement ran on and whether the tree was dirty ("tree bersih" in the result files). docs/hasil holds the
 * results of the runs themselves, so it is left out of the dirty check: the first run must not make the next one look dirty.
 * Any other change, tracked or untracked, counts.
 */
export function commitInfo(cwd: string = process.cwd()): { commit: string; dirty: boolean } {
  const run = (args: string[]): string =>
    spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
  return {
    commit: run(['rev-parse', 'HEAD']),
    dirty: run(['status', '--porcelain', '--', '.', ':(exclude)docs/hasil']).length > 0,
  };
}
