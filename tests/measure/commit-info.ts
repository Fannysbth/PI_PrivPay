import { spawnSync } from 'node:child_process';

/**
 * The commit a measurement ran on and whether the tree was dirty ("tree bersih" in the result files). docs/hasil holds the
 * results of the runs themselves, so it is left out of the dirty check: the first run must not make the next one look dirty.
 * Any other change, tracked or untracked, counts. When git cannot answer, this throws: a result file must never claim a
 * clean tree for an unknown commit.
 */
export function commitInfo(cwd: string = process.cwd()): { commit: string; dirty: boolean } {
  const run = (args: string[]): string => {
    const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (done.error !== undefined || done.status !== 0) {
      throw new Error(`git ${args[0] ?? ''} failed; the commit of the measurement is unknown`);
    }
    return done.stdout.trim();
  };
  return {
    commit: run(['rev-parse', 'HEAD']),
    dirty: run(['status', '--porcelain', '--', '.', ':(exclude)docs/hasil']).length > 0,
  };
}
