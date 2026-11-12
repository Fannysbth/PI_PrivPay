import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';

// DK-02b: the Lua plugin of Kong passes the same contract vectors as the Tokenizer of the adapter
// (services/gateway/test/gateway-contract.spec.ts). The Lua runs in a throwaway container of the pinned Kong image;
// luacheck runs in a throwaway container of its own image. Neither adds a dependency to the repository.
const ROOT = join(__dirname, '..', '..', '..');
const PLUGIN = join(ROOT, 'services', 'gateway', 'plugins', 'privacy-tokenizer');
const VECTORS = join(ROOT, 'tests', 'security', 'gateway-contract');
const KONG_IMAGE =
  'kong:3.9.4@sha256:c1f5fbb80cd666b4b29b4e97875ecd64d93b01b23fb3083bc3e424b3bad5fdd5';
const LUACHECK_IMAGE =
  'ghcr.io/lunarmodules/luacheck@sha256:46601a794d24e86dda2a94d957cfba6a451db7c0f4f61f8abe04c4fcd5184e0f';

interface Vector {
  name: string;
  route: string;
  canary: number;
  body: unknown;
  expect: { outbound?: unknown; error?: string; privacy_calls: number };
}
interface Result {
  name: string;
  outbound?: unknown;
  error?: string;
  privacy_calls: number;
  privacy_batches: number;
}

const fill = (text: string, values: Readonly<Record<string, string>>): string =>
  text.replace(/\{\{([a-z_]+)\}\}/g, (_whole, name: string) => values[name] ?? '');

const files = readdirSync(VECTORS).filter((name) => name.endsWith('.json'));
const vectors: Vector[] = files.map((file) => {
  const text = readFileSync(join(VECTORS, file), 'utf8');
  return JSON.parse(fill(text, buildCanary((JSON.parse(text) as Vector).canary))) as Vector;
});

function docker(args: string[]): { status: number | null; out: string } {
  const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 100_000 });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('DK-02b the Lua plugin core passes the contract vectors', () => {
  let results: Result[] = [];
  let work = '';

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'privpay-lua-'));
    writeFileSync(join(work, 'vectors.json'), JSON.stringify(vectors));
    const run = docker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${PLUGIN}:/plugin:ro`,
      '-v',
      `${work}:/work:ro`,
      '--entrypoint',
      'resty',
      KONG_IMAGE,
      '/plugin/spec/run-vectors.lua',
      '/work/vectors.json',
    ]);
    if (run.status !== 0) throw new Error(`the vector runner failed: ${run.out.slice(0, 400)}`);
    results = JSON.parse(run.out) as Result[];
  }, 110_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('DK-02b there is a result for every vector, including the notification route', () => {
    expect(results.map((result) => result.name)).toEqual(vectors.map((vector) => vector.name));
    expect(vectors.some((vector) => vector.route === 'notification')).toBe(true);
  });

  it.each(vectors.map((vector, index) => [vector.name, index] as const))(
    'DK-02b %s',
    (_name, index) => {
      const vector = vectors[index] as Vector;
      const result = results[index] as Result;
      expect(result.privacy_calls).toBe(vector.expect.privacy_calls);
      // ADR-0019: a payment asks for P1 and P2 in one batch; no other route uses one.
      expect(result.privacy_batches).toBe(
        vector.route === 'transaction' && vector.expect.privacy_calls > 0 ? 1 : 0,
      );
      if (vector.expect.error !== undefined) {
        expect(result.error).toBe(vector.expect.error);
        expect(result.outbound).toBeUndefined();
      } else {
        expect(result.error).toBeUndefined();
        expect(result.outbound).toEqual(vector.expect.outbound);
        // The phone is the deliberate exception of the notification route (Metodologi, flow 8).
        const canary = buildCanary(vector.canary);
        assertNoFindings(
          scanText(
            JSON.stringify(result.outbound),
            [vector.route === 'notification' ? { ...canary, hp: 'not-sent' } : canary],
            { service: 'downstream', location: 'outbound' },
          ),
        );
      }
    },
  );
});

describe('DK-02b the plugin is clean under luacheck', () => {
  it('DK-02b luacheck reports no warning (image pinned by digest)', () => {
    const run = docker([
      'run',
      '--rm',
      '-v',
      `${PLUGIN}:/src:ro`,
      '-w',
      '/src',
      LUACHECK_IMAGE,
      '--no-color',
      '.',
    ]);
    expect(run.status).toBe(0);
    expect(run.out).toContain('0 warnings / 0 errors');
  });

  it('DK-02b the images used here are the ones Compose pins', () => {
    const compose = readFileSync(join(ROOT, 'deploy', 'compose', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain(KONG_IMAGE);
  });
});
