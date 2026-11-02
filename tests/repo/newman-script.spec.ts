import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// M6-01: the ticket names `pnpm newman`; the runner is the pinned-image script of DK-02a. Seam: the scripts of
// package.json. The alias must run the same file as `docker:newman` (no second runner, no new dependency).
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('M6-01 pnpm newman', () => {
  it('M6-01 newman runs the same script as docker:newman', () => {
    expect(pkg.scripts['docker:newman']).toBe('node scripts/docker/newman.cjs');
    expect(pkg.scripts['newman']).toBe(pkg.scripts['docker:newman']);
  });

  it('M6-01 adds no newman package to the dependencies', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((name) => name.includes('newman'))).toEqual([]);
  });
});
