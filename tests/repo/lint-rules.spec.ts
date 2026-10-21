import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Each lint test starts a type-aware ESLint run; allow for a slow CI runner.
jest.setTimeout(30_000);
const root = join(__dirname, '..', '..');

interface EslintResult {
  messages: { ruleId: string | null }[];
}

/** Runs the real ESLint CLI, so the test exercises exactly what `pnpm lint` runs. */
async function rulesReportedFor(fixture: string): Promise<(string | null)[]> {
  const eslintBin = join(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  // --no-ignore lints the fixtures even though the repo-wide lint run skips them. ESLint exits with 1 when it
  // reports errors, which is the expected outcome here, so the JSON on stdout is read either way.
  const { stdout } = await run(
    process.execPath,
    [eslintBin, '--no-ignore', '--format', 'json', join('tests/repo/fixtures', fixture)],
    { cwd: root },
  ).catch((error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code !== 1) throw error; // exit code 1 = lint errors reported; anything else is a crash
    return { stdout: failure.stdout ?? '' };
  });
  const [result] = JSON.parse(stdout) as EslintResult[];
  return (result?.messages ?? []).map((message) => message.ruleId);
}

describe('M0-01 the lint configuration enforces the project conventions', () => {
  it('M0-01 reports console.* in service code (S-45)', async () => {
    expect(await rulesReportedFor('uses-console.ts')).toContain('no-console');
  });

  it('M0-01 reports explicit any (CLAUDE.md conventions)', async () => {
    expect(await rulesReportedFor('uses-any.ts')).toContain('@typescript-eslint/no-explicit-any');
  });

  it('M0-01 reports an empty catch block (qa-checklist E-06)', async () => {
    expect(await rulesReportedFor('empty-catch.ts')).toContain('no-empty');
  });

  it('M0-01 reports a floating promise', async () => {
    expect(await rulesReportedFor('floating-promise.ts')).toContain(
      '@typescript-eslint/no-floating-promises',
    );
  });

  it('M0-01 reports focused and skipped tests (CLAUDE.md, qa-checklist Q-05)', async () => {
    const rules = await rulesReportedFor('focused-test.ts');
    expect(rules.filter((rule) => rule === 'no-restricted-properties')).toHaveLength(2);
    expect(rules).toContain('no-restricted-globals');
  });

  it('M1-02 reports === , !== , == and .equals between secrets (Phase 2 requirement: safeEqual only)', async () => {
    const rules = await rulesReportedFor('compares-secret.ts');
    expect(rules.filter((rule) => rule === 'no-restricted-syntax')).toHaveLength(8);
  });

  it('M1-02 accepts timingSafeEqual, a length check and presence checks on secrets', async () => {
    expect(await rulesReportedFor('compares-secret-safely.ts')).toEqual([]);
  });

  it('M0-01 accepts clean typed code', async () => {
    expect(await rulesReportedFor('clean.ts')).toEqual([]);
  });
});

describe('M0-01 the TypeScript configuration is strict and covers every workspace folder', () => {
  async function effectiveConfig(): Promise<{
    compilerOptions: Record<string, unknown>;
    include: string[];
  }> {
    const tscBin = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    const { stdout } = await run(
      process.execPath,
      [tscBin, '--showConfig', '-p', 'tsconfig.json'],
      {
        cwd: root,
      },
    );
    return JSON.parse(stdout) as { compilerOptions: Record<string, unknown>; include: string[] };
  }

  it('M0-01 enables strict and noUncheckedIndexedAccess (ADR-0002)', async () => {
    const { compilerOptions } = await effectiveConfig();
    expect(compilerOptions.strict).toBe(true);
    expect(compilerOptions.noUncheckedIndexedAccess).toBe(true);
  });

  it('M0-01 type-checks the src and test folders of packages, services and tools', async () => {
    const { include } = await effectiveConfig();
    for (const area of ['packages', 'services', 'tools']) {
      expect(include).toContain(`${area}/*/src/**/*.ts`);
      expect(include).toContain(`${area}/*/test/**/*.ts`);
    }
  });
});

describe('M0-01 the toolchain is pinned (ADR-0002)', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    packageManager?: string;
  };

  it('M0-01 locks Node 24 in .nvmrc and engines', () => {
    expect(readFileSync(join(root, '.nvmrc'), 'utf8').trim()).toBe('24');
    expect(manifest.engines?.node).toBe('>=24 <25');
  });

  it('M0-01 locks the package manager version', () => {
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
});
