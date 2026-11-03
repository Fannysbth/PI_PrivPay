import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// M7-C (Metodologi D.4, "mikrobenchmark"): the token-issue microbenchmark is a standalone script, not a Jest suite. These
// tests read it and exercise only its pure helpers; no timing number is asserted or produced here.
const root = join(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS script (like scripts/perf/plan.cjs)
const bench = require('../../scripts/perf/token-microbench.cjs') as {
  percentile: (sorted: number[], p: number) => number;
  summarize: (samplesNs: number[]) => Record<string, number>;
  TOKEN_SHAPE: RegExp;
};
const source = readFileSync(join(root, 'scripts', 'perf', 'token-microbench.cjs'), 'utf8');

describe('M7-C token-issue microbenchmark', () => {
  it('M7-C uses the real TokenMint with throwaway in-memory keys, never the key files', () => {
    expect(source).toContain("require('node:crypto')");
    expect(source).toMatch(/randomBytes\(32\)/);
    expect(source).not.toMatch(/secrets|_FILE|readFileSync\(.*key/i);
  });

  it('M7-C accepts only the PSEU-plus-8-hex token shape', () => {
    expect(bench.TOKEN_SHAPE.test('PSEU-7BCD04F2')).toBe(true);
    expect(bench.TOKEN_SHAPE.test('PSEU-7bcd04f2')).toBe(false);
    expect(bench.TOKEN_SHAPE.test('PSEU-7BCD04F')).toBe(false);
  });

  it('M7-C computes nearest-rank percentiles over sorted samples', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(bench.percentile(sorted, 50)).toBe(50);
    expect(bench.percentile(sorted, 95)).toBe(95);
    expect(bench.percentile(sorted, 99)).toBe(99);
    expect(bench.percentile([7], 99)).toBe(7);
  });

  it('M7-C summarizes samples without mutating the input', () => {
    const samples = [5, 1, 3, 2, 4];
    const out = bench.summarize(samples);
    expect(samples).toEqual([5, 1, 3, 2, 4]);
    expect(out).toMatchObject({ count: 5, minNs: 1, maxNs: 5, meanNs: 3, p50Ns: 3 });
  });

  it('M7-C writes a readiness file that says it is not official, with runner metadata', () => {
    expect(source).toContain('official: false');
    for (const field of ['nodeVersion', 'cpuModel', 'totalMemoryGB', 'treeClean', 'commit'])
      expect(source).toContain(field);
  });
});
