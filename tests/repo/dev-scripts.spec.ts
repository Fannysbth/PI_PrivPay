import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBankSimulatorConfig } from '../../services/bank-simulator/src/config';
import { loadFraudConfig } from '../../services/fraud-service/src/config';
import { loadGatewayConfig } from '../../services/gateway/src/config';
import { loadNotificationConfig } from '../../services/notification-service/src/config';
import { loadPrivacyConfig } from '../../services/privacy-service/src/config';
import { loadReconciliationConfig } from '../../services/reconciliation-service/src/config';
import { loadSmsSimulatorConfig } from '../../services/sms-simulator/src/config';
import { loadTransactionConfig } from '../../services/transaction-service/src/config';
import { loadDevIdpConfig } from '../../tools/dev-idp/src/config';
import { SERVICE_CLIENTS } from '../../tools/dev-idp/src/registry';

// Seam: the plan that `pnpm dev:up` runs and the script that makes the Privacy keys (3c, N-50). The plan is checked
// against the real configuration loaders of every process, so it cannot drift from what the services accept, and the
// rules of N-47 (no PRIVACY_SERVICE_URL in baseline, no Privacy process) are asserted on it. Secrets are fake files.
interface Proc {
  readonly name: string;
  readonly port: number;
  readonly entry: string;
  readonly env: Record<string, string>;
}
interface Services {
  PORTS: Record<string, number>;
  PRIVACY_KEY_FILES: string[];
  CLIENT_SECRET_FILES: string[];
  BASELINE_DB_SERVICES: string[];
  buildPlan(mode: string, options: { secretsDir: string }): Proc[];
  childEnv(
    parent: Record<string, string | undefined>,
    proc: Proc,
  ): Record<string, string | undefined>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const services = require('../../scripts/dev/services.cjs') as Services;
const root = join(__dirname, '..', '..');
const keysScript = join(root, 'scripts', 'dev', 'keys.cjs');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-dev-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Fake files for every secret the plan names, each different, so the loaders can read them. */
function fakeSecrets(): void {
  let n = 0;
  for (const file of [...services.PRIVACY_KEY_FILES, ...services.CLIENT_SECRET_FILES]) {
    n += 1;
    writeFileSync(
      join(dir, file),
      PRIVACY_KEYS.has(file)
        ? `${String(n).repeat(64).slice(0, 62)}${String(n).padStart(2, '0')}\n`
        : `fake-secret-${file}-0123456789abcdef\n`,
    );
  }
}
const PRIVACY_KEYS = new Set(services.PRIVACY_KEY_FILES);

const pg = { PG_HOST: 'localhost', PG_PORT: '5432', PG_SECRETS_DIR: '.' };
const loaders: Record<string, (env: Record<string, string>) => unknown> = {
  idp: loadDevIdpConfig,
  privacy: loadPrivacyConfig,
  transaction: loadTransactionConfig,
  fraud: loadFraudConfig,
  notification: loadNotificationConfig,
  reconciliation: loadReconciliationConfig,
  bank: loadBankSimulatorConfig,
  sms: loadSmsSimulatorConfig,
  gateway: loadGatewayConfig,
};

describe('3c the ports are written down in one place', () => {
  it('3c nine processes in proposed, each on its own loopback port, Privacy on 4001', () => {
    const plan = services.buildPlan('proposed', { secretsDir: dir });
    expect(plan.map((p) => p.name)).toEqual([
      'idp',
      'privacy',
      'transaction',
      'fraud',
      'notification',
      'reconciliation',
      'bank',
      'sms',
      'gateway',
    ]);
    expect(new Set(plan.map((p) => p.port)).size).toBe(plan.length);
    expect(services.PORTS['privacy']).toBe(4001);
    for (const proc of plan) expect(proc.env['PORT']).toBe(String(proc.port));
  });

  it('3c everything that needs Privacy is pointed at the one port of it', () => {
    const plan = services.buildPlan('proposed', { secretsDir: dir });
    const pointed = plan
      .filter((p) => p.env['PRIVACY_SERVICE_URL'] !== undefined)
      .map((p) => p.name);
    expect(pointed.sort()).toEqual(['gateway', 'notification', 'reconciliation', 'transaction']);
    for (const proc of plan) {
      if (proc.env['PRIVACY_SERVICE_URL'] !== undefined)
        expect(proc.env['PRIVACY_SERVICE_URL']).toBe('http://127.0.0.1:4001');
    }
  });
});

describe('3c N-47 N-50 baseline is a plan of its own', () => {
  const baseline = (): Proc[] => services.buildPlan('baseline', { secretsDir: dir });

  it('3c N-47 baseline has no Privacy process and no variable that names one', () => {
    const plan = baseline();
    expect(plan.map((p) => p.name)).not.toContain('privacy');
    for (const proc of plan) expect(Object.keys(proc.env)).not.toContain('PRIVACY_SERVICE_URL');
    for (const proc of plan) expect(proc.env['PRIVACY_MODE']).toBe('baseline');
  });

  it('3c N-50 the four services with a database of their own get the disposable suffix, no other does', () => {
    const plan = baseline();
    const suffixed = plan
      .filter((p) => p.env['PG_DATABASE_SUFFIX'] !== undefined)
      .map((p) => p.name);
    expect(suffixed.sort()).toEqual([...services.BASELINE_DB_SERVICES].sort());
    const proposed = services.buildPlan('proposed', { secretsDir: dir });
    for (const proc of proposed) expect(Object.keys(proc.env)).not.toContain('PG_DATABASE_SUFFIX');
  });

  it('3c a mode other than the two is refused', () => {
    expect(() => services.buildPlan('static', { secretsDir: dir })).toThrow(RangeError);
  });
});

describe('3c the shell cannot decide which database a process uses', () => {
  const stray = { PG_DATABASE_SUFFIX: 'stray', PATH: 'p' };

  it('3c proposed: a suffix left in the shell or in .env.test never reaches a process', () => {
    for (const proc of services.buildPlan('proposed', { secretsDir: dir })) {
      expect(services.childEnv(stray, proc)['PG_DATABASE_SUFFIX']).toBeUndefined();
    }
  });

  it('3c baseline: the four services get the suffix of the plan, not the one of the shell, and the others none', () => {
    for (const proc of services.buildPlan('baseline', { secretsDir: dir })) {
      const suffix = services.childEnv(stray, proc)['PG_DATABASE_SUFFIX'];
      if (services.BASELINE_DB_SERVICES.includes(proc.name)) expect(suffix).toBe('devbl');
      else expect(suffix).toBeUndefined();
    }
  });

  it('3c the rest of the environment is handed on, and the plan wins over the shell', () => {
    const [proc] = services.buildPlan('proposed', { secretsDir: dir });
    if (proc === undefined) throw new Error('empty plan');
    const env = services.childEnv({ PATH: 'p', PORT: '1' }, proc);
    expect(env['PATH']).toBe('p');
    expect(env['PORT']).toBe(proc.env['PORT']);
  });
});

describe('3c the environment of every process is one its own configuration loader accepts', () => {
  for (const mode of ['proposed', 'baseline']) {
    it(`3c ${mode}: every process loads its configuration`, () => {
      fakeSecrets();
      const plan = services.buildPlan(mode, { secretsDir: dir });
      for (const proc of plan) {
        const load = loaders[proc.name];
        if (load === undefined) throw new Error(`no loader for ${proc.name}`);
        expect(() => load({ ...pg, ...proc.env })).not.toThrow();
      }
    });
  }

  it('3c a secret is only ever a path in the plan, never a value', () => {
    fakeSecrets();
    const text = JSON.stringify([
      ...services.buildPlan('proposed', { secretsDir: dir }),
      ...services.buildPlan('baseline', { secretsDir: dir }),
    ]);
    for (const file of readdirSync(dir)) {
      const value = readFileSync(join(dir, file), 'utf8').trim();
      expect(text).not.toContain(value);
    }
  });

  it('3c the service accounts of the plan are those of the dev IdP', () => {
    expect([...services.CLIENT_SECRET_FILES].sort()).toEqual(
      SERVICE_CLIENTS.map((client) => `${client}_client_secret`).sort(),
    );
  });
});

describe('3c dev:keys makes the three keys of Privacy and touches nothing that exists', () => {
  const run = () => {
    const result = spawnSync(process.execPath, [keysScript], {
      env: { PATH: process.env['PATH'] ?? '', DEV_SECRETS_DIR: dir },
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it('3c three files of 32 random bytes in hex, all different, and only names printed', () => {
    const { status, output } = run();
    expect(status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([...services.PRIVACY_KEY_FILES].sort());
    const values = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8'));
    for (const value of values) {
      expect(value).toMatch(/^[0-9a-f]{64}\n$/);
      expect(output).not.toContain(value.trim());
    }
    expect(new Set(values).size).toBe(3);
  });

  it('3c a key that exists is kept as it is, and the others are still made', () => {
    const existing = join(dir, 'blind_index_secret');
    writeFileSync(existing, 'existing-fake-value\n');
    const { status, output } = run();
    expect(status).toBe(0);
    expect(readFileSync(existing, 'utf8')).toBe('existing-fake-value\n');
    expect(output).toContain('kept');
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it('3c a second run changes nothing', () => {
    run();
    const first = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8'));
    run();
    expect(readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8'))).toEqual(first);
  });
});

describe('3c the logs and process ids of dev:up are never committed', () => {
  it('3c .dev-run/ is ignored', () => {
    const result = spawnSync(
      'git',
      ['check-ignore', '--no-index', '-q', '--', '.dev-run/logs/pids.json'],
      {
        cwd: root,
      },
    );
    expect(result.status).toBe(0);
  });
});
