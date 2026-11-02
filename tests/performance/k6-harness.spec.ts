import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// M7-A (ticket M7-01 readiness, NFR-18): static tests of the performance harness. They read files only: nothing here starts
// Docker or k6, and no number is produced. Seams: the decisions of scripts/perf/plan.cjs, the k6 script, the monitoring Compose file
// and the Prometheus and Grafana files.
const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS runner script (like scripts/docker/compose.cjs)
const plan = require('../../scripts/perf/plan.cjs') as {
  K6_IMAGE: string;
  OFFICIAL: { vus: number; warmup: string; duration: string; repeats: number; thinkMs: number };
  alternation: (repeats: number, first?: string) => { run: number; mode: string }[];
  seconds: (duration: string) => number;
  isOfficialShape: (p: {
    vus: number;
    warmup: string;
    duration: string;
    thinkMs: number;
  }) => boolean;
  k6DockerArgs: (o: Record<string, unknown>) => string[];
  resourceQueries: (windowSeconds: number) => Record<string, string>;
};

interface ComposeService {
  profiles?: string[];
  image?: string;
  ports?: string[];
  deploy?: { resources?: { limits?: { memory?: string } } };
  environment?: Record<string, string>;
  volumes?: string[];
}
const monitoring = parse(read('deploy', 'compose', 'docker-compose.monitoring.yml')) as {
  services: Record<string, ComposeService>;
};
const k6Script = read('tests', 'performance', 'mixed.k6.js');

describe('M7-01 run plan', () => {
  it('M7-01 alternates baseline and proposed, baseline first (Metodologi D.5)', () => {
    expect(plan.alternation(5).map((e) => e.mode)).toEqual([
      'baseline',
      'proposed',
      'baseline',
      'proposed',
      'baseline',
      'proposed',
      'baseline',
      'proposed',
      'baseline',
      'proposed',
    ]);
    expect(plan.alternation(2, 'proposed').map((e) => e.mode)).toEqual([
      'proposed',
      'baseline',
      'proposed',
      'baseline',
    ]);
    expect(() => plan.alternation(0)).toThrow(RangeError);
  });

  it('M7-01 the official shape is 100 users, 60 s warm-up, 300 s, five repeats; a small load is not official', () => {
    expect(plan.OFFICIAL).toEqual({
      vus: 100,
      warmup: '60s',
      duration: '300s',
      repeats: 5,
      thinkMs: 0,
    });
    expect(plan.isOfficialShape({ vus: 100, warmup: '1m', duration: '5m', thinkMs: 0 })).toBe(true);
    expect(plan.isOfficialShape({ vus: 10, warmup: '0s', duration: '60s', thinkMs: 0 })).toBe(
      false,
    );
    expect(plan.isOfficialShape({ vus: 100, warmup: '60s', duration: '300s', thinkMs: 500 })).toBe(
      false,
    );
    expect(() => plan.seconds('90')).toThrow(RangeError);
  });

  it('M7-01 the runner labels a non-official run as readiness and never calls it official', () => {
    const runner = read('scripts', 'perf', 'run.cjs');
    expect(runner).toContain("o.official ? 'resmi' : 'kesiapan'");
    expect(runner).toContain('--official needs the Metodologi parameters');
    expect(runner).toMatch(/official: o\.official/);
  });

  it('M7-01 each run starts from a fresh stack: down -v before up (database reset)', () => {
    const runner = read('scripts', 'perf', 'run.cjs');
    expect(runner.indexOf("['down', '-v'")).toBeGreaterThan(-1);
    expect(runner.indexOf("['down', '-v'")).toBeLessThan(runner.indexOf("['up', '-d', '--wait']"));
  });
});

describe('M7-01 load generator container', () => {
  const args = plan.k6DockerArgs({
    containerName: 'privpay-k6-run-baseline',
    network: 'privpay-baseline_edge',
    caFile: '/x/ca.crt',
    passwordFile: '/x/pw',
    scriptDir: '/x/s',
    outDir: '/x/o',
    mode: 'baseline',
    vus: 10,
    warmup: '0s',
    duration: '60s',
    thinkMs: 0,
    runBase: 123,
  });

  it('M7-01 k6 is pinned by digest and nothing is added to the repository dependencies', () => {
    expect(plan.K6_IMAGE).toMatch(/^grafana\/k6@sha256:[0-9a-f]{64}$/);
    expect(args).toContain(plan.K6_IMAGE);
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: object;
      devDependencies?: object;
      scripts: Record<string, string>;
    };
    expect(
      Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => n.includes('k6')),
    ).toEqual([]);
    expect(pkg.scripts['perf:run']).toBe('node scripts/perf/run.cjs');
  });

  it('M7-01 the test password is a mounted file; TLS is verified against the dev CA', () => {
    const text = args.join(' ');
    expect(text).toContain('/x/pw:/secret/customer_password:ro');
    expect(text).toContain('SSL_CERT_FILE=/ca/ca.crt');
    expect(text).not.toMatch(/password=|PASSWORD=|secret=/i);
    expect(text).not.toMatch(/insecure/i);
  });
});

describe('M7-01 mixed scenario script', () => {
  it('M7-01 sends 30% suspicious payments, each at or above the Fraud threshold of 1.000.000', () => {
    expect(k6Script).toMatch(/SUSPICIOUS_PER_TEN = 3;/);
    expect(k6Script).toMatch(/__ITER % 10 < SUSPICIOUS_PER_TEN/);
    const amount = /SUSPICIOUS_AMOUNT = ([0-9_]+);/.exec(k6Script);
    expect(Number((amount?.[1] ?? '0').replace(/_/g, ''))).toBeGreaterThanOrEqual(1_000_000);
    const normal = /NORMAL_AMOUNT = ([0-9_]+);/.exec(k6Script);
    expect(Number((normal?.[1] ?? '0').replace(/_/g, ''))).toBeLessThan(1_000_000);
  });

  it('M7-01 the mode is a parameter and the run measures after a warm-up scenario', () => {
    expect(k6Script).toMatch(/MODE !== 'baseline' && MODE !== 'proposed'/);
    expect(k6Script).toContain('startTime: WARMUP,');
    expect(k6Script).toContain('scenario:measure');
  });

  it('M7-01 data is built at run time: no literal secret, UUID, token or TLS bypass in the script', () => {
    expect(k6Script).not.toMatch(/insecureSkipTLSVerify/);
    expect(k6Script).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(k6Script).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(k6Script).toContain("open('/secret/customer_password')");
    expect(k6Script).toContain('99995'); // the canary NIK prefix: plainly false data
    expect(k6Script).toContain('@example.test');
  });
});

describe('NFR-18 monitoring (cAdvisor, Prometheus, Grafana)', () => {
  const services = ['prometheus', 'cadvisor', 'grafana'];

  it('NFR-18 all three are in the profile monitoring, pinned by digest, with a memory limit', () => {
    for (const name of services) {
      const s = monitoring.services[name];
      expect(s?.profiles).toEqual(['monitoring']);
      expect(s?.image).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(s?.deploy?.resources?.limits?.memory).toMatch(/^\d+M$/);
    }
  });

  it('NFR-18 only Grafana is published, on the loopback of the host', () => {
    expect(monitoring.services['prometheus']?.ports).toBeUndefined();
    expect(monitoring.services['cadvisor']?.ports).toBeUndefined();
    for (const port of monitoring.services['grafana']?.ports ?? [])
      expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('NFR-18 the Grafana password is a file secret, not a value in the file', () => {
    const env = monitoring.services['grafana']?.environment ?? {};
    expect(Object.keys(env)).toContain('GF_SECURITY_ADMIN_PASSWORD__FILE');
    expect(Object.keys(env)).not.toContain('GF_SECURITY_ADMIN_PASSWORD');
    expect(env['GF_AUTH_ANONYMOUS_ENABLED']).toBe('false');
  });

  it('NFR-18 cAdvisor is a version that sees containers on Docker Desktop (not v0.52.1)', () => {
    expect(monitoring.services['cadvisor']?.image).not.toContain('v0.52.1');
  });

  it('NFR-18 Prometheus picks its file by condition; baseline has no Privacy Service target, proposed has it', () => {
    expect(monitoring.services['prometheus']?.volumes?.join(' ')).toContain(
      'prometheus.${PRIVPAY_MODE:?',
    );
    const targets = (file: string): string[] => {
      const doc = parse(read('deploy', 'prometheus', file)) as {
        scrape_configs: { job_name: string; static_configs: { targets: string[] }[] }[];
      };
      return doc.scrape_configs.flatMap((j) => j.static_configs.flatMap((c) => c.targets));
    };
    expect(targets('prometheus.baseline.yml').some((t) => t.startsWith('privacy-service'))).toBe(
      false,
    );
    expect(targets('prometheus.proposed.yml')).toContain('privacy-service:4001');
    for (const file of ['prometheus.baseline.yml', 'prometheus.proposed.yml']) {
      expect(targets(file)).toContain('cadvisor:8080');
      expect(targets(file)).toContain('gateway:4010');
    }
  });

  it('NFR-18 Grafana provisions the Prometheus data source and a dashboard from files', () => {
    const source = parse(
      read('deploy', 'grafana', 'provisioning', 'datasources', 'prometheus.yml'),
    ) as {
      datasources: { uid: string; url: string }[];
    };
    const dash = JSON.parse(read('deploy', 'grafana', 'dashboards', 'privpay-resources.json')) as {
      panels: { datasource: { uid: string }; targets: { expr: string }[] }[];
    };
    expect(source.datasources[0]?.url).toBe('http://prometheus:9090');
    expect(dash.panels.length).toBeGreaterThanOrEqual(2);
    for (const panel of dash.panels) expect(panel.datasource.uid).toBe(source.datasources[0]?.uid);
    expect(
      dash.panels.some((p) =>
        p.targets.some((t) => t.expr.includes('container_cpu_usage_seconds_total')),
      ),
    ).toBe(true);
    expect(
      dash.panels.some((p) =>
        p.targets.some((t) => t.expr.includes('container_memory_working_set_bytes')),
      ),
    ).toBe(true);
  });

  it('NFR-18 the resource queries read CPU and memory per Compose service over the given window', () => {
    const q = plan.resourceQueries(300);
    expect(q['cpuCoresMean']).toContain('[300s:10s]');
    expect(q['memoryBytesPeak']).toContain('max_over_time');
    for (const expr of Object.values(q))
      expect(expr).toContain('container_label_com_docker_compose_service');
  });
});
