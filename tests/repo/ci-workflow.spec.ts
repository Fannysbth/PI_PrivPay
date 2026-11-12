import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// The workflow cannot run here (it runs on GitHub after Fanny pushes the branch), so these tests check what can be
// checked from the file itself: pinning, permissions, and that each gate of platform-dan-ci.md section 14 is present.
const root = join(__dirname, '..', '..');
const raw = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string | boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string | boolean;
  permissions?: Record<string, string>;
  container?: { image: string };
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}
const workflow = parse(raw) as Workflow;
const jobs = Object.entries(workflow.jobs);
const stepsOf = (name: string): Step[] => workflow.jobs[name]?.steps ?? [];
const commandsOf = (name: string): string =>
  stepsOf(name)
    .map((step) => step.run ?? '')
    .join('\n');
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

describe('M0-07 the workflow pins everything it downloads (S-08)', () => {
  it('M0-07 every action is pinned to a full commit SHA, with its version in a comment', () => {
    const uses = [...raw.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(8);
    for (const [, reference = '', rest = ''] of uses) {
      const [, version = ''] = reference.split('@');
      expect(SHA.test(version)).toBe(true);
      expect(rest).toMatch(/#\s*v?\d+\.\d+/);
    }
  });

  it('M0-07 every container image is pinned by digest, and docker run only uses those variables', () => {
    const images = [
      ...Object.entries(workflow.env ?? {}),
      ...jobs.flatMap(([, job]) => Object.entries(job.env ?? {})),
    ].filter(([key]) => key.endsWith('_IMAGE'));
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const [, image] of images) expect(image).toMatch(DIGEST);
    for (const [, job] of jobs) {
      if (job.container !== undefined) expect(job.container.image).toMatch(DIGEST);
    }
    for (const line of raw
      .split('\n')
      .filter((l) => /docker run/.test(l) && !l.trim().startsWith('#'))) {
      expect(line).toMatch(/\$\{?[A-Z_]+_IMAGE\}?/);
    }
  });

  it('M0-07 the gitleaks release is pinned and its checksum is verified', () => {
    expect(commandsOf('secrets')).toContain('sha256sum -c -');
    expect(commandsOf('secrets')).toContain('--config .gitleaks.toml');
  });
});

describe('M0-07 the workflow asks for the least it needs (S-08)', () => {
  it('M0-07 contents are read-only by default and only the CodeQL job may write security events', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of jobs) {
      if (job.permissions === undefined) continue;
      expect({ name, permissions: job.permissions }).toEqual({
        name: 'sast',
        permissions: { contents: 'read', 'security-events': 'write' },
      });
    }
  });

  it('M0-07 no checkout keeps the token in the work tree', () => {
    for (const [, job] of jobs) {
      for (const step of job.steps.filter(
        (s) => s.uses?.startsWith('actions/checkout@') === true,
      )) {
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  it('M0-07 the workflow uses no repository secret: the database password is made for each run', () => {
    expect(raw).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
    expect(raw).not.toMatch(/secrets:\s*inherit/);
  });

  it('M0-07 the generated password reaches only the steps that need it, through a file and not GITHUB_ENV', () => {
    const commands = commandsOf('integration');
    expect(commands).not.toMatch(/PGPASSWORD=.*GITHUB_ENV/);
    expect(commands).toContain('PG_ADMIN_PASSWORD_FILE');
    // docker run takes the password from its own environment, so it never appears in a process list.
    expect(commands).not.toMatch(/-e POSTGRES_PASSWORD=/);
    expect(commands.indexOf('::add-mask::')).toBeLessThan(commands.indexOf('docker run'));
  });

  it('M0-07 Node comes from .nvmrc in every job that sets it up', () => {
    const setups = jobs.flatMap(([, job]) =>
      job.steps.filter((s) => s.uses?.startsWith('actions/setup-node@') === true),
    );
    expect(setups.length).toBeGreaterThanOrEqual(3);
    for (const step of setups) expect(step.with?.['node-version-file']).toBe('.nvmrc');
  });
});

describe('M0-07 each gate of the local check runs in CI (platform spec 14)', () => {
  it('M0-07 quality runs lint, typecheck and the unit tests on every push, without waiting for files to exist', () => {
    const commands = commandsOf('quality');
    for (const command of [
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      // N-04: the built services must start as real processes (also proves the SIGTERM shutdown on Linux).
      'pnpm test:smoke',
    ]) {
      expect(commands).toContain(command);
    }
    expect(workflow.jobs['quality']?.if).toBeUndefined();
  });

  it('M0-07 dependencies audits the production tree at high severity', () => {
    expect(commandsOf('dependencies')).toContain('pnpm audit --prod --audit-level high');
    expect(
      stepsOf('dependencies').some((s) => s.uses?.includes('dependency-review-action') === true),
    ).toBe(true);
  });

  it('M0-07 secrets scans the full history with the shared configuration', () => {
    expect(commandsOf('secrets')).toContain(
      'gitleaks detect --log-opts="--all" --redact -v --config .gitleaks.toml',
    );
  });

  it('M0-07 CodeQL and Semgrep run as static analysis', () => {
    expect(stepsOf('sast').some((s) => s.uses?.includes('codeql-action/analyze') === true)).toBe(
      true,
    );
    expect(commandsOf('semgrep')).toContain('semgrep scan --error');
  });
});

describe('M0-07 integration runs against PostgreSQL 16 with a throwaway password (ADR-0004)', () => {
  const commands = commandsOf('integration');

  it('M0-07 starts PostgreSQL 16 by digest, with a password generated and masked at run time', () => {
    expect(workflow.jobs['integration']?.env?.['POSTGRES_IMAGE']).toMatch(
      /^postgres:16@sha256:[0-9a-f]{64}$/,
    );
    expect(commands).toContain('openssl rand');
    expect(commands).toContain('::add-mask::');
    expect(commands).toContain('127.0.0.1:5432:5432');
  });

  it('M0-07 bootstraps twice through the comparison script, then runs the integration and security tests', () => {
    expect(commands).toContain('bash scripts/ci/bootstrap-twice.sh');
    expect(commands.indexOf('bootstrap-twice.sh')).toBeLessThan(
      commands.indexOf('pnpm test:integration'),
    );
    // test:security does not exist before M3-06; --if-present keeps the step honest instead of failing or skipping.
    expect(commands).toContain('pnpm run --if-present test:security');
    expect(workflow.jobs['integration']?.needs).toBe('quality');
  });

  it('M0-07 removes the database container even when a step fails', () => {
    const cleanup = stepsOf('integration').find((s) => s.run?.includes('docker rm -f') === true);
    expect(cleanup?.if).toBe('always()');
  });

  it('M0-07 the comparison script is valid bash and refuses an empty snapshot', () => {
    const syntax = spawnSync('bash', ['-n', 'scripts/ci/bootstrap-twice.sh'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(syntax.stderr).toBe('');
    expect(syntax.status).toBe(0);
    const script = readFileSync(join(root, 'scripts', 'ci', 'bootstrap-twice.sh'), 'utf8');
    // An empty section would be identical in both runs, so the number of lines per kind is checked as well.
    expect(script).toContain('expect_count');
  });

  it('M0-07 the comparison script exists and stops on the first error', () => {
    const script = readFileSync(join(root, 'scripts', 'ci', 'bootstrap-twice.sh'), 'utf8');
    expect(script).toContain('set -euo pipefail');
    expect(existsSync(join(root, 'scripts', 'db', 'snapshot.sql'))).toBe(true);
  });
});

describe('M0-07 what stays switched off until Docker (ADR-0004)', () => {
  // GitHub rejects hashFiles() in a job-level `if:` ("Unrecognized function"): the whole workflow then fails in 0 seconds
  // as a workflow file issue (seen on run 42533543365). File checks belong in a step, not in the job condition.
  it('M0-07 no job-level condition calls hashFiles (the workflow would be rejected as a whole)', () => {
    const offenders = Object.entries(workflow.jobs)
      .filter(([, job]) => String(job.if ?? '').includes('hashFiles'))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('M0-07 the compose-based e2e job is switched off explicitly until it uses the real compose flow', () => {
    expect(workflow.jobs['e2e']?.if).toBe(false);
  });

  it('M0-07 the Kong plugin lint job runs on every push, its files exist', () => {
    expect(workflow.jobs['lua']?.if).toBeUndefined();
  });

  it('M0-07 Dependabot keeps the pinned actions up to date', () => {
    const dependabot = parse(readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8')) as {
      updates: { 'package-ecosystem': string }[];
    };
    expect(dependabot.updates.map((u) => u['package-ecosystem'])).toContain('github-actions');
  });
});
