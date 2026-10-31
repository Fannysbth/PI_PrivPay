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
  networks?: string[];
  profiles?: string[];
  healthcheck?: { test?: string[] };
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
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
    // Compose merges lists of networks as a union.
    const networks = [...new Set([...(into.networks ?? []), ...(extra.networks ?? [])])];
    Object.assign(into, extra, { environment, secrets, networks });
    if (extra.ports !== undefined) into.ports = extra.ports;
  }
  return out;
}

// Variables whose name ends in KEY but whose value is the path of a secret file, not the secret (third-party names).
const PATH_VALUED_KEYS = new Set(['KONG_SSL_CERT_KEY']);

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

    it('DK-01 DK-02a only Kong (the edge) is published, only on the loopback of the host and only to its TLS port', () => {
      const published = Object.entries(services).filter(([, s]) => s.ports !== undefined);
      expect(published.map(([name]) => name)).toEqual(['kong']);
      for (const port of published[0]?.[1].ports ?? [])
        expect(port).toMatch(/^127\.0\.0\.1:\$\{GATEWAY_HOST_PORT:-40(10|11)\}:8443$/);
      // The adapter is reached through Kong only.
      expect(services['gateway']?.ports).toBeUndefined();
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
        else if (name === 'kong')
          expect(service.image).toMatch(/^kong:3\.9\.4@sha256:[0-9a-f]{64}$/);
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
            // KONG_SSL_CERT_KEY is Kong's own variable for the path of its TLS key (DK-02a); the value is checked below.
            const isPath = key.endsWith('_FILE') || PATH_VALUED_KEYS.has(key);
            expect({ name, key, file: isPath }).toEqual({ name, key, file: true });
            expect(value).toMatch(/^\/run\/secrets\/[A-Za-z0-9_.-]+$/);
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
          /^\$\{PRIVPAY_SECRETS_DIR:-\.\.\/\.\.\/secrets\/docker\}\/[A-Za-z0-9_.-]+$/,
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
      // TLS exists only in Docker (DK-03): the local phase stays on loopback HTTP (ADR-0004).
      const dockerOnly = new Set([
        'BIND_HOST',
        'PG_HOST',
        'PG_PORT',
        'PG_SECRETS_DIR',
        'TLS_CERT_FILE',
        'TLS_KEY_FILE',
        'NODE_EXTRA_CA_CERTS',
        // DK-02a: the edge sits in front of the adapter only in Docker; the IdP lifetime is a knob of the edge-check.
        'EDGE_PROXY_HOPS',
        'EDGE_TOKENIZATION',
        'EDGE_ADAPTER_SECRET_FILE',
        'ACCESS_TOKEN_TTL_SECONDS',
      ]);
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
    // kong-config only tells the tokenizing plugin of Kong where Privacy is (DK-02b); it calls nothing itself.
    expect(callers).toEqual([
      'gateway',
      'kong-config',
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
        // Kong and its config step read no PRIVACY_MODE: the edge is the same in both conditions (DK-02a).
        if (service.profiles !== undefined || name.startsWith('pg-') || name === 'kong') continue;
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TLS_SECRETS } = require('../../scripts/docker/tls.cjs') as {
      TLS_SECRETS: Record<string, string>;
    };
    const made = new Set([...plan().keys(), ...Object.keys(TLS_SECRETS)]);
    for (const name of Object.keys(base.secrets ?? {}))
      expect({ name, ok: made.has(name) }).toEqual({ name, ok: true });
  });
});

describe.each(MODES)('DK-03 the three networks and TLS in the %s condition (NFR-06)', (mode) => {
  const services = merged(mode);
  const on = (network: string): string[] =>
    Object.entries(services)
      .filter(([, service]) => (service.networks ?? []).includes(network))
      .map(([name]) => name)
      .sort();
  const proposed = mode === 'proposed';

  it('DK-03 has exactly edge, business and privacy; only edge can leave, the others are internal', () => {
    expect(Object.keys(base.networks ?? {}).sort()).toEqual(['business', 'edge', 'privacy']);
    expect(base.networks?.['edge']?.internal).not.toBe(true);
    expect(base.networks?.['business']?.internal).toBe(true);
    expect(base.networks?.['privacy']?.internal).toBe(true);
  });

  it('DK-03 DK-02a only Kong is on the edge, and it is the only published service', () => {
    expect(on('edge')).toEqual(['kong']);
    expect(
      Object.entries(services)
        .filter(([, service]) => service.ports !== undefined)
        .map(([name]) => name),
    ).toEqual(['kong']);
    // The adapter has no way out and is not in front: only Kong reaches it, from the business network.
    expect(services['gateway']?.networks).not.toContain('edge');
  });

  it('DK-02a Kong has TLS only, no admin API, no plain HTTP listener, no version headers, and the adapter trusts one proxy', () => {
    const kong = services['kong']?.environment ?? {};
    expect(kong['KONG_DATABASE']).toBe('off');
    expect(kong['KONG_PROXY_LISTEN']).toBe('0.0.0.0:8443 ssl');
    expect(kong['KONG_ADMIN_LISTEN']).toBe('off');
    expect(kong['KONG_HEADERS']).toBe('off');
    expect(kong['KONG_PROXY_ACCESS_LOG']).toBe('off');
    expect(kong['KONG_SSL_CERT']).toBe('/run/secrets/tls_kong_crt');
    expect(kong['KONG_SSL_CERT_KEY']).toBe('/run/secrets/tls_kong_key');
    // Only the plugins DK-02a uses are loaded; a custom or unused one is not.
    expect(String(kong['KONG_PLUGINS']).split(',').sort()).toEqual([
      'correlation-id',
      'jwt',
      'post-function',
      'privacy-tokenizer',
      'prometheus',
      'rate-limiting',
      'request-size-limiting',
      'request-termination',
    ]);
    // Kong starts only after the declarative file was written from the IdP key, and after the adapter is healthy.
    expect(services['kong']?.depends_on).toMatchObject({
      'kong-config': { condition: 'service_completed_successfully' },
      gateway: { condition: 'service_healthy' },
    });
    expect(services['gateway']?.environment?.['EDGE_PROXY_HOPS']).toBe('1');
  });

  it('DK-03 every service is on a network, and none is on the default or a host network', () => {
    for (const [name, service] of Object.entries(services))
      expect({ name, networks: (service.networks ?? []).length > 0 }).toEqual({
        name,
        networks: true,
      });
  });

  it('DK-03 the databases of the business services are on business only, not reachable from privacy or the edge', () => {
    for (const name of ['pg-transaction', 'pg-fraud', 'pg-notification', 'pg-reconciliation'])
      expect({ name, networks: services[name]?.networks }).toEqual({
        name,
        networks: ['business'],
      });
  });

  if (proposed) {
    it('DK-03 Privacy Service, its database and its migration are on privacy only', () => {
      for (const name of ['privacy-service', 'pg-privacy', 'migrate-privacy'])
        expect({ name, networks: services[name]?.networks }).toEqual({
          name,
          networks: ['privacy'],
        });
    });

    it('DK-03 DK-02b only Kong (the tokenizing edge), the Gateway, the three callers and the IdP share the privacy network', () => {
      expect(on('privacy')).toEqual(
        [
          'gateway',
          'idp',
          'kong',
          'migrate-privacy',
          'notification-service',
          'pg-privacy',
          'privacy-service',
          'reconciliation-service',
          'transaction-service',
        ].sort(),
      );
      // Fraud never calls Privacy (invariant 2, decision 3a): it has no way in.
      expect(services['fraud-service']?.networks).toEqual(['business']);
    });

    it('DK-03 the Privacy Service serves TLS, with the certificate and key as Docker secrets', () => {
      const privacy = services['privacy-service'];
      expect(privacy?.environment?.['TLS_CERT_FILE']).toBe('/run/secrets/tls_privacy_crt');
      expect(privacy?.environment?.['TLS_KEY_FILE']).toBe('/run/secrets/tls_privacy_key');
      expect(privacy?.secrets).toEqual(
        expect.arrayContaining(['tls_privacy_crt', 'tls_privacy_key']),
      );
      // Its own health check goes through TLS too, by the name the certificate carries.
      expect((privacy?.healthcheck?.test ?? []).join(' ')).toContain('https://privacy-service:');
    });

    it('DK-03 every caller reaches Privacy over https and trusts only the dev CA file', () => {
      for (const name of [
        'gateway',
        'transaction-service',
        'notification-service',
        'reconciliation-service',
      ]) {
        const service = services[name];
        expect({ name, url: service?.environment?.['PRIVACY_SERVICE_URL'] }).toEqual({
          name,
          url: 'https://privacy-service:4001',
        });
        expect({ name, ca: service?.environment?.['NODE_EXTRA_CA_CERTS'] }).toEqual({
          name,
          ca: '/run/secrets/tls_ca_crt',
        });
        expect(service?.secrets).toContain('tls_ca_crt');
      }
    });
  } else {
    it('DK-03 nobody is on the privacy network without the Privacy Service', () => {
      expect(on('privacy')).toEqual([]);
    });
  }

  it('DK-03 nothing switches certificate verification off', () => {
    for (const [name, service] of Object.entries(services))
      expect({ name, off: service.environment?.['NODE_TLS_REJECT_UNAUTHORIZED'] }).toEqual({
        name,
        off: undefined,
      });
    for (const file of [
      'deploy/compose/docker-compose.yml',
      'deploy/compose/mode.proposed.yml',
      'deploy/docker/Dockerfile',
    ])
      expect(text(file)).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });
});
