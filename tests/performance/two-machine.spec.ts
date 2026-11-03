import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// M7-D (N-61, option A): static tests of the two-machine setup. They read files and call pure helpers; nothing starts Docker or k6.
const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS runner script (like scripts/perf/plan.cjs)
const plan = require('../../scripts/perf/plan.cjs') as {
  k6DockerArgs: (o: Record<string, unknown>) => string[];
  errorQueries: () => Record<string, string>;
  lanTarget: (
    ip: string,
    kongPort: number,
    idpPort: number,
  ) => { kongAddr: string; idpAddr: string };
  assertLanIp: (ip: string) => string;
};
const lan = parse(read('deploy', 'measure', 'compose.lan.yml')) as {
  services: Record<string, { ports?: string[]; networks?: string[] }>;
};
const base = {
  containerName: 'c',
  caFile: '/x/ca.crt',
  passwordFile: '/x/pw',
  scriptDir: '/x/s',
  outDir: '/x/o',
  mode: 'proposed',
  vus: 10,
  warmup: '0s',
  duration: '60s',
  pace: 'saturation',
  runBase: 1,
};

describe('M7-D LAN override (Kong and Keycloak only)', () => {
  it('M7-D opens only kong and keycloak, each on ONE address taken from PRIVPAY_LAN_IP with no default', () => {
    expect(Object.keys(lan.services).sort()).toEqual(['keycloak', 'kong']);
    for (const s of Object.values(lan.services)) {
      expect(s.ports).toHaveLength(1);
      expect(s.ports?.[0]).toMatch(/^'?\$\{PRIVPAY_LAN_IP:\?[^}]+\}:/);
    }
    const text = read('deploy', 'measure', 'compose.lan.yml');
    expect(text).not.toMatch(/PRIVPAY_LAN_IP:-/);
    for (const p of Object.values(lan.services).flatMap((x) => x.ports ?? []))
      expect(p).not.toContain('0.0.0.0');
  });

  it('M7-D keycloak joins the edge network so the published port is reachable', () => {
    expect(lan.services['keycloak']?.networks).toEqual(['edge']);
  });

  it('M7-D the official files and the monitoring file still publish loopback only', () => {
    for (const f of [
      ['deploy', 'compose', 'docker-compose.yml'],
      ['deploy', 'compose', 'mode.proposed.yml'],
      ['deploy', 'compose', 'mode.baseline.yml'],
      ['deploy', 'compose', 'docker-compose.monitoring.yml'],
      ['docs', 'postman', 'compose.postman.yml'],
    ]) {
      const text = read(...f);
      expect(text).not.toContain('PRIVPAY_LAN_IP');
      const doc = parse(text) as { services?: Record<string, { ports?: string[] }> };
      for (const svc of Object.values(doc.services ?? {}))
        for (const port of svc.ports ?? []) expect(port).toMatch(/^127.0.0.1:/);
    }
  });

  it('M7-D accepts one private IPv4 address and refuses 0.0.0.0, loopback, names and ranges', () => {
    expect(plan.assertLanIp('192.168.1.20')).toBe('192.168.1.20');
    expect(plan.assertLanIp('10.0.0.5')).toBe('10.0.0.5');
    for (const bad of [
      '0.0.0.0',
      '127.0.0.1',
      '8.8.8.8',
      'localhost',
      '192.168.1.0/24',
      '192.168.1',
      '',
    ])
      expect(() => plan.assertLanIp(bad)).toThrow(RangeError);
  });
});

describe('M7-D k6 target parameters', () => {
  it('M7-D keeps the single-machine defaults when no target is given', () => {
    const text = plan.k6DockerArgs({ ...base, network: 'privpay-proposed_edge' }).join(' ');
    expect(text).toContain('BASE_URL=https://kong:8443');
    expect(text).toContain('IDP_URL=http://keycloak:8080');
    expect(text).toContain('--network privpay-proposed_edge');
    expect(text).not.toMatch(/KONG_ADDR|IDP_ADDR/);
  });

  it('M7-D takes Kong, the IdP and the host map from parameters; no network on the second machine', () => {
    const args = plan.k6DockerArgs({ ...base, ...plan.lanTarget('192.168.1.20', 4443, 8080) });
    const text = args.join(' ');
    expect(text).not.toContain('--network');
    expect(text).toContain('KONG_ADDR=192.168.1.20:4443');
    expect(text).toContain('IDP_ADDR=192.168.1.20:8080');
    expect(text).toContain('BASE_URL=https://kong:8443');
  });

  it('M7-D keeps TLS verified: the host map keeps the name kong, which the certificate covers', () => {
    expect(read('tests', 'performance', 'mixed.k6.js')).toContain('hosts');
    expect(read('tests', 'performance', 'mixed.k6.js')).not.toMatch(/insecureSkipTLSVerify/);
  });
});

describe('M7-D timing and error metrics in the result', () => {
  const script = read('tests', 'performance', 'mixed.k6.js');
  it('M7-D keeps blocked, connecting and waiting of the measured requests', () => {
    for (const m of ['http_req_blocked', 'http_req_connecting', 'http_req_waiting'])
      expect(script).toContain(`'${m}{scenario:measure,target:kong}'`);
  });

  it('M7-D asks Prometheus for the 5xx counters of the services (timeouts and retries are not metered)', () => {
    const q = plan.errorQueries();
    expect(q['http5xxByInstance']).toContain('privpay_http_requests_total');
    expect(q['http5xxByInstance']).toContain('5..');
    expect(read('scripts', 'perf', 'run.cjs')).toContain('errorQueries');
  });
});

describe('M7-D runbook', () => {
  const book = read('docs', 'hasil', 'kinerja', 'RUNBOOK-dua-mesin.md');
  it('M7-D limits the firewall rule to the second laptop and says how to remove it', () => {
    expect(book).toMatch(/New-NetFirewallRule[^\n]*-RemoteAddress/);
    expect(book).toMatch(/Remove-NetFirewallRule/);
    expect(book).not.toMatch(/-RemoteAddress\s+(Any|\*|0\.0\.0\.0)/i);
  });
  it('M7-D names the risk of Keycloak on the LAN and how to close it', () => {
    expect(book).toMatch(/Keycloak/);
    expect(book).toMatch(/Risiko/);
    expect(book).toMatch(/menutup/i);
  });
});
