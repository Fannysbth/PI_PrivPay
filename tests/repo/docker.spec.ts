import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// DK-01a: what the Docker files must guarantee, checked on the files themselves (no Docker needed): pinned images, a
// non-root user, no secret in an image or an environment value, one published port on the host's loopback, the same
// limits in both conditions, and the same environment as `dev:up` (scripts/dev/services.cjs). S-06, S-60, NFR-19, NFR-22.
const root = join(__dirname, '..', '..');
const text = (path: string): string => readFileSync(join(root, path), 'utf8');

interface ComposeService {
  image?: string;
  user?: string;
  cap_drop?: string[];
  security_opt?: string[];
  read_only?: boolean;
  privileged?: boolean;
  network_mode?: string;
  ports?: string[];
  secrets?: string[];
  profiles?: string[];
  environment?: Record<string, string>;
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } };
}
interface Compose {
  name?: string;
  services: Record<string, ComposeService>;
  secrets?: Record<string, { file: string }>;
  networks?: Record<string, { internal?: boolean }>;
}

const load = (path: string): Compose => parse(text(path), { merge: true }) as Compose;
const base = load('deploy/compose/docker-compose.yml');
const monitoring = load('deploy/compose/docker-compose.monitoring.yml');
const MODES = ['proposed', 'baseline'] as const;
type Mode = (typeof MODES)[number];
const modeFile: Record<Mode, Compose> = {
  proposed: load('deploy/compose/mode.proposed.yml'),
  baseline: load('deploy/compose/mode.baseline.yml'),
};

/** What `docker compose -f docker-compose.yml -f mode.<m>.yml config` would hold, for the keys these tests read. */
function merged(mode: Mode): Record<string, ComposeService> {
  const out: Record<string, ComposeService> = {};
  for (const [name, service] of Object.entries(base.services)) out[name] = structuredClone(service);
  for (const [name, extra] of Object.entries(modeFile[mode].services)) {
    const into = (out[name] ??= {});
    const environment = { ...(into.environment ?? {}), ...(extra.environment ?? {}) };
    const secrets = [...(into.secrets ?? []), ...(extra.secrets ?? [])];
    Object.assign(into, extra, { environment, secrets });
    if (extra.ports !== undefined) into.ports = extra.ports;
  }
  return out;
}

describe('DK-01 the Dockerfile (NFR-22, TK-18, S-06)', () => {
  // Comments explain why; only instructions are checked.
  const dockerfile = text('deploy/docker/Dockerfile')
    .split(String.fromCharCode(10))
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(String.fromCharCode(10));

  it('DK-01 pins the base image by version and digest, never :latest', () => {
    const from = /^ARG NODE_IMAGE=(\S+)$/m.exec(dockerfile)?.[1] ?? '';
    expect(from).toMatch(/^node:\d+\.\d+\.\d+-[a-z0-9-]+@sha256:[0-9a-f]{64}$/);
    expect(dockerfile).not.toMatch(/:latest/);
  });

  it('DK-01 is multi-stage and the runtime stage runs as the non-root node user', () => {
    expect(dockerfile.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(2);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(runtime).toMatch(/^USER node$/m);
    expect(runtime).not.toMatch(/^COPY \. /m);
  });

  it('DK-01 holds no secret: no ARG or ENV with a secret-like name, no copy of secrets/ or .env', () => {
    expect(dockerfile).not.toMatch(/^\s*(ARG|ENV)\s+\w*(PASSWORD|SECRET|TOKEN|KEY)\w*/im);
    expect(dockerfile).not.toMatch(/secrets|\.env/);
  });

  it('DK-01 .dockerignore keeps secrets, .env, dev state and node_modules out of the build context', () => {
    const ignore = text('.dockerignore')
      .split(/\r?\n/)
      .filter((line) => line !== '' && !line.startsWith('#'));
    for (const entry of ['secrets', '.env', '.dev-state', 'node_modules', '.git'])
      expect(ignore).toContain(entry);
  });
});

describe.each(MODES)(
  'DK-01 the Compose stack in the %s condition (S-06, NFR-19, FR-30)',
  (mode) => {
    const services = merged(mode);
    const running = Object.entries(services).filter(([, s]) => s.profiles === undefined);

    it('DK-01 every service drops all capabilities, forbids new privileges and has a read-only root', () => {
      for (const [name, service] of Object.entries(services)) {
        expect({ name, cap_drop: service.cap_drop }).toEqual({ name, cap_drop: ['ALL'] });
        expect({ name, opt: service.security_opt }).toEqual({
          name,
          opt: ['no-new-privileges:true'],
        });
        expect({ name, read_only: service.read_only }).toEqual({ name, read_only: true });
        expect(service.privileged).toBeUndefined();
        expect(service.network_mode).toBeUndefined();
      }
    });

    it('DK-01 only the Gateway is published, and only on the loopback of the host', () => {
      const published = Object.entries(services).filter(([, s]) => s.ports !== undefined);
      expect(published.map(([name]) => name)).toEqual(['gateway']);
      for (const port of published[0]?.[1].ports ?? []) expect(port).toMatch(/^127\.0\.0\.1:/);
      expect(base.networks?.['internal']?.internal).toBe(true);
    });

    it('DK-01 every image is pinned (a version, and a digest for the PostgreSQL image) and none is :latest', () => {
      for (const [name, service] of running) {
        expect({ name, image: service.image }).toEqual({
          name,
          image: service.image,
        });
        expect(service.image ?? '').not.toMatch(/:latest/);
        expect(service.image ?? '').toMatch(/:[^:@/]+(@|$)/);
        if (name.startsWith('pg-'))
          expect(service.image).toMatch(/^postgres:16\.\d+@sha256:[0-9a-f]{64}$/);
        else expect(service.image).toMatch(/^privpay-[a-z-]+:dk01a$/);
      }
    });

    it('DK-01 every service has a CPU and memory limit', () => {
      for (const [name, service] of running) {
        const limits = service.deploy?.resources?.limits;
        expect({ name, ok: limits?.cpus !== undefined && limits.memory !== undefined }).toEqual({
          name,
          ok: true,
        });
      }
    });

    it('DK-01 no secret value is in an environment variable: a password, secret or key is only a *_FILE path under /run/secrets', () => {
      for (const [name, service] of Object.entries(services)) {
        for (const [key, value] of Object.entries(service.environment ?? {})) {
          if (/(PASSWORD|SECRET|KEY)(_FILE)?$/.test(key) && !/_VERSION$/.test(key)) {
            expect({ name, key, file: key.endsWith('_FILE') }).toEqual({ name, key, file: true });
            expect(value).toMatch(/^\/run\/secrets\/[A-Za-z0-9_-]+$/);
          }
        }
      }
    });

    it('DK-01 every secret a service names exists, is mounted into that service, and comes from the git-ignored folder', () => {
      const defined = new Set(Object.keys(base.secrets ?? {}));
      for (const [name, service] of Object.entries(services)) {
        const mounted = new Set(service.secrets ?? []);
        for (const secret of mounted)
          expect({ name, secret, ok: defined.has(secret) }).toEqual({ name, secret, ok: true });
        for (const value of Object.values(service.environment ?? {})) {
          const file = /^\/run\/secrets\/(.+)$/.exec(value)?.[1];
          if (file !== undefined)
            expect({ name, file, ok: mounted.has(file) }).toEqual({ name, file, ok: true });
        }
      }
      for (const entry of Object.values(base.secrets ?? {}))
        expect(entry.file).toMatch(
          /^\$\{PRIVPAY_SECRETS_DIR:-\.\.\/\.\.\/secrets\/docker\}\/[A-Za-z0-9_-]+$/,
        );
    });

    it('DK-01 each service environment equals the one dev:up gives it, plus only where Docker needs another', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildPlan } = require('../../scripts/dev/services.cjs') as {
        buildPlan: (
          mode: string,
          options: { secretsDir: string },
        ) => { name: string; env: Record<string, string> }[];
      };
      const composeName: Record<string, string> = {
        idp: 'idp',
        privacy: 'privacy-service',
        transaction: 'transaction-service',
        fraud: 'fraud-service',
        notification: 'notification-service',
        reconciliation: 'reconciliation-service',
        bank: 'bank-simulator',
        sms: 'sms-simulator',
        gateway: 'gateway',
      };
      const dockerOnly = new Set(['BIND_HOST', 'PG_HOST', 'PG_PORT', 'PG_SECRETS_DIR']);
      const localOnly = new Set(['PG_DATABASE_SUFFIX']);
      for (const planned of buildPlan(mode, { secretsDir: 'secrets' })) {
        const service = services[composeName[planned.name] ?? ''];
        const wanted = Object.keys(planned.env)
          .filter((key) => !localOnly.has(key))
          .sort();
        const have = Object.keys(service?.environment ?? {})
          .filter((key) => !dockerOnly.has(key))
          .sort();
        expect({ name: planned.name, keys: have }).toEqual({ name: planned.name, keys: wanted });
      }
    });
  },
);

describe('DK-01 the two conditions differ only by the privacy layer (ADR-0003, N-47, Metodologi C.3)', () => {
  const proposed = merged('proposed');
  const baseline = merged('baseline');

  it('DK-01 baseline has no Privacy Service, no database for it, and no service is given PRIVACY_SERVICE_URL', () => {
    for (const name of ['privacy-service', 'pg-privacy', 'migrate-privacy']) {
      expect(Object.keys(baseline)).not.toContain(name);
      expect(Object.keys(proposed)).toContain(name);
    }
    for (const service of Object.values(baseline))
      expect(service.environment?.['PRIVACY_SERVICE_URL']).toBeUndefined();
    const callers = Object.entries(proposed)
      .filter(([, s]) => s.environment?.['PRIVACY_SERVICE_URL'] !== undefined)
      .map(([name]) => name)
      .sort();
    expect(callers).toEqual([
      'gateway',
      'notification-service',
      'reconciliation-service',
      'transaction-service',
    ]);
  });

  it('DK-01 every service in both conditions has identical CPU and memory limits and the same image', () => {
    for (const [name, service] of Object.entries(baseline)) {
      expect({ name, limits: proposed[name]?.deploy }).toEqual({ name, limits: service.deploy });
      expect({ name, image: proposed[name]?.image }).toEqual({ name, image: service.image });
    }
    expect(proposed['pg-privacy']?.deploy).toEqual(proposed['pg-fraud']?.deploy);
  });

  it('DK-01 PRIVACY_MODE is set by the mode file, to its own condition, on every service that reads it', () => {
    for (const mode of MODES) {
      for (const [name, service] of Object.entries(merged(mode))) {
        if (service.profiles !== undefined || name.startsWith('pg-')) continue;
        expect({ name, mode: service.environment?.['PRIVACY_MODE'] }).toEqual({ name, mode });
      }
      expect(base.services['gateway']?.environment?.['PRIVACY_MODE']).toBeUndefined();
      expect(modeFile[mode].name).toBe(`privpay-${mode}`);
    }
  });

  it('DK-01 the monitoring services are only a definition: all in a profile, none in the base file', () => {
    for (const service of Object.values(monitoring.services))
      expect(service.profiles).toEqual(['monitoring']);
    expect(Object.keys(base.services)).not.toContain('prometheus');
  });
});

describe('DK-01 the PostgreSQL init script and the secret maker (S-60)', () => {
  it('DK-01 the init script reads passwords from /run/secrets inside psql, never from argv or the environment', () => {
    const script = text('deploy/postgres/init-service-db.sh');
    expect(script).toContain('/run/secrets/');
    expect(script).not.toMatch(/-v\s+pw|PASSWORD=|echo .*pw_/);
  });

  it('DK-01 every Compose secret has a file made by docker:secrets, and the folder is git-ignored', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { plan } = require('../../scripts/docker/make-secrets.cjs') as {
      plan: () => Map<string, unknown>;
    };
    const made = new Set(plan().keys());
    for (const name of Object.keys(base.secrets ?? {}))
      expect({ name, ok: made.has(name) }).toEqual({ name, ok: true });
  });
});
