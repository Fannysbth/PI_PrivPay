import { generateKeyPairSync } from 'node:crypto';
import { toClientError, DomainError } from '@privpay/common';
import { buildKongConfig, jwkToPem, type KongConfigInput } from '../src/edge/kong-config';

// DK-02a: Kong 3.9.4 (DB-less) in front of the gateway adapter. The declarative file is built at start from the IdP's
// public key, so it holds no secret and no literal key (CLAUDE.md, secrets).
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = pair.publicKey.export({ format: 'jwk' });
const input = (over: Partial<KongConfigInput> = {}): KongConfigInput => ({
  publicKeyPem: jwkToPem(publicJwk),
  issuer: 'test-issuer',
  upstreamUrl: 'http://gateway:4010',
  rateLimit: { enabled: true, perMinute: 300 },
  maxPayloadBytes: 65_536,
  maxTokenLifetimeSeconds: 300,
  tokenizer: {
    action: 'tokenize',
    privacyUrl: 'https://privacy-service:4001',
    idpUrl: 'http://idp:4000',
    clientSecretFile: '/run/secrets/api-gateway_client_secret',
    edgeSecretFile: '/run/secrets/edge_adapter_secret',
  },
  ...over,
});

interface Plugin {
  name: string;
  config?: Record<string, unknown>;
}
interface Route {
  name: string;
  methods?: string[];
  paths: string[];
  protocols?: string[];
  plugins?: Plugin[];
}
interface Config {
  _format_version: string;
  services: { url: string; retries: number; routes: Route[] }[];
  consumers: { jwt_secrets: Record<string, unknown>[] }[];
  plugins: Plugin[];
}
const build = (over?: Partial<KongConfigInput>): Config =>
  buildKongConfig(input(over)) as unknown as Config;
const routes = (config: Config): Route[] => config.services[0]?.routes ?? [];
const route = (config: Config, name: string): Route => {
  const found = routes(config).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no route ${name}`);
  return found;
};
const hasJwt = (candidate: Route): boolean =>
  (candidate.plugins ?? []).some((plugin) => plugin.name === 'jwt');

describe('DK-02a jwkToPem turns the IdP key into a public PEM only', () => {
  it('DK-02a exports a public key', () => {
    expect(jwkToPem(publicJwk)).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });
  it('DK-02a refuses a JWK that carries private parameters', () => {
    const privateJwk = pair.privateKey.export({ format: 'jwk' });
    expect(() => jwkToPem(privateJwk)).toThrow(/private/);
  });
});

describe('DK-02a Kong declarative config: who needs a token', () => {
  it('DK-02a only /register and /health are open; every other route needs a token', () => {
    const config = build();
    const open = routes(config)
      .filter((candidate) => !hasJwt(candidate))
      .map((candidate) => candidate.name)
      .sort();
    expect(open).toEqual(['health', 'register']);
    expect(hasJwt(route(config, 'api'))).toBe(true);
  });

  it('DK-02a /register accepts POST only and /health GET only, each by exact path', () => {
    const config = build();
    expect(route(config, 'register').methods).toEqual(['POST']);
    expect(route(config, 'register').paths).toEqual(['~/register$']);
    expect(route(config, 'health').methods).toEqual(['GET']);
    expect(route(config, 'health').paths).toEqual(['~/health$']);
  });

  it('N-54b /health is answered by Kong itself with status only: no mode, and no hop to the adapter', () => {
    const health = route(build(), 'health');
    expect(health.plugins).toEqual([
      {
        name: 'request-termination',
        config: { status_code: 200, content_type: 'application/json', body: '{"status":"ok"}' },
      },
    ]);
  });

  it('DK-02a /metrics is not served on the public listener (N-05): a token is asked first, then it is refused', () => {
    const metrics = route(build(), 'metrics-blocked');
    // Express matches /metrics/ and /Metrics too (non-strict, case-insensitive routing), so the block must as well.
    expect(metrics.paths).toEqual(['~/(?i)metrics/*$']);
    expect(metrics.plugins?.map((plugin) => plugin.name).sort()).toEqual([
      'jwt',
      'request-termination',
    ]);
  });

  it('DK-02a the catch-all route forwards everything else and the upstream path is never rewritten', () => {
    const config = build();
    expect(route(config, 'api').paths).toEqual(['/']);
    const service = config.services[0];
    expect(service?.url).toBe('http://gateway:4010');
    // A hidden retry could repeat a payment; the adapter has its own idempotency and retry rules (NFR-12).
    expect(service?.retries).toBe(0);
    for (const candidate of routes(config)) expect(candidate.protocols).toEqual(['https']);
  });
});

describe('DK-02a Kong declarative config: the JWT plugin', () => {
  const jwt = (): Plugin | undefined =>
    route(build(), 'api').plugins?.find((plugin) => plugin.name === 'jwt');

  it('DK-02a verifies exp, caps the lifetime at 300 s (ADR-0007 item 7) and reads the Authorization header only', () => {
    expect(jwt()?.config).toMatchObject({
      key_claim_name: 'iss',
      claims_to_verify: ['exp'],
      maximum_expiration: 300,
      header_names: ['authorization'],
      // A token in a URL or a cookie is never read (CLAUDE.md: no JWT in the URL).
      uri_param_names: [],
      cookie_names: [],
    });
    expect(jwt()?.config?.['anonymous']).toBeUndefined();
  });

  it('DK-02a the single consumer holds the IdP public key under the issuer; no secret or private key', () => {
    const [credential, ...rest] = build().consumers.flatMap((consumer) => consumer.jwt_secrets);
    expect(rest).toEqual([]);
    expect(credential).toMatchObject({ key: 'test-issuer', algorithm: 'RS256' });
    expect(String(credential?.['rsa_public_key'])).toMatch(/BEGIN PUBLIC KEY/);
    expect(JSON.stringify(build())).not.toMatch(/PRIVATE|"secret"/);
  });
});

describe('DK-02a Kong declarative config: limits', () => {
  const global = (config: Config, name: string): Plugin | undefined =>
    config.plugins.find((plugin) => plugin.name === name);

  it('DK-02a limits the body size and the request rate per client address', () => {
    const config = build();
    expect(global(config, 'request-size-limiting')?.config).toMatchObject({
      allowed_payload_size: 65_536,
      size_unit: 'bytes',
    });
    expect(global(config, 'rate-limiting')?.config).toMatchObject({
      minute: 300,
      limit_by: 'ip',
      policy: 'local',
    });
  });

  it('DK-02a RATE_LIMIT_ENABLED=false leaves the rate limit out (performance runs only, the same in both modes)', () => {
    const config = build({ rateLimit: { enabled: false, perMinute: 300 } });
    expect(global(config, 'rate-limiting')).toBeUndefined();
    expect(global(config, 'request-size-limiting')).toBeDefined();
  });

  it('DK-02a rejects a limit or size that is not a positive whole number', () => {
    expect(() => build({ rateLimit: { enabled: true, perMinute: 0 } })).toThrow(RangeError);
    expect(() => build({ maxPayloadBytes: 1.5 })).toThrow(RangeError);
    expect(() => build({ maxTokenLifetimeSeconds: 0 })).toThrow(RangeError);
  });
});

describe('DK-02a Kong refusals take the ADR-0008 shape', () => {
  const lua = (): string => {
    const mapper = build().plugins.find((plugin) => plugin.name === 'post-function');
    const config = mapper?.config as Record<string, string[]> | undefined;
    return [...(config?.['header_filter'] ?? []), ...(config?.['body_filter'] ?? [])].join('\n');
  };

  it('DK-02a carries status and message of each client code from the same table the adapter uses', () => {
    for (const reason of [
      'UNAUTHENTICATED',
      'FORBIDDEN_ROLE',
      'VALIDATION_ERROR',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      'INTERNAL_ERROR',
    ] as const) {
      const { status, body } = toClientError(new DomainError(reason, 'edge'), '0'.repeat(32));
      const { code, message } = body.error;
      expect(lua()).toContain(`${code} = { ${String(status)}, "${message}" }`);
    }
  });

  it('DK-02a leaves the answers of the adapter alone (only errors Kong itself produced are rewritten)', () => {
    expect(lua()).toContain('kong.response.get_source() == "service"');
  });

  it('DK-02a maps 413 to VALIDATION_ERROR, since ADR-0008 has no 413', () => {
    expect(lua()).toMatch(/else name = "VALIDATION_ERROR"/);
  });
});

describe('DK-02b Kong declarative config: the privacy-tokenizer plugin', () => {
  const tokenizer = (config: Config): Plugin | undefined =>
    config.plugins.find((plugin) => plugin.name === 'privacy-tokenizer');

  it('DK-02b proposed: the plugin knows Privacy, the IdP and the paths of two secret files, and holds no secret', () => {
    const plugin = tokenizer(build());
    expect(plugin?.config).toMatchObject({
      action: 'tokenize',
      privacy_url: 'https://privacy-service:4001',
      idp_url: 'http://idp:4000',
      client_secret_file: '/run/secrets/api-gateway_client_secret',
      edge_secret_file: '/run/secrets/edge_adapter_secret',
    });
    // Privacy is reached over TLS only (NFR-06).
    expect(String(plugin?.config?.['privacy_url'])).toMatch(/^https:/);
  });

  it('DK-02b passthrough (the baseline condition): the plugin is told so and nothing else, so it cannot reach Privacy', () => {
    const plugin = tokenizer(build({ tokenizer: { action: 'passthrough' } }));
    expect(plugin?.config?.['action']).toBe('passthrough');
    expect(Object.keys(plugin?.config ?? {}).sort()).toEqual(['action']);
  });

  it('DK-02b maps every reason of Privacy to the status a client sees, from the table of the adapter', () => {
    const reasons = tokenizer(build())?.config?.['reasons'] as Record<string, number>;
    expect(reasons['POLICY_NOT_ALLOWED']).toBe(403);
    expect(reasons['TOKEN_NOT_FOUND']).toBe(403);
    expect(reasons['VALIDATION_ERROR']).toBe(422);
    expect(reasons['RATE_LIMITED']).toBe(429);
    expect(reasons['SERVICE_UNAVAILABLE']).toBe(503);
    expect(reasons['INTERNAL_ERROR']).toBe(500);
    expect(reasons['IDEMPOTENCY_CONFLICT']).toBe(409);
  });

  it('DK-02b proposed without a URL or a secret path is refused at render time (fail fast)', () => {
    const good = input().tokenizer;
    if (good.action !== 'tokenize') throw new Error('fixture');
    for (const missing of ['privacyUrl', 'idpUrl', 'clientSecretFile', 'edgeSecretFile'] as const) {
      const broken = { ...good, [missing]: undefined };
      expect(() => build({ tokenizer: broken })).toThrow(new RegExp(missing));
    }
    expect(() =>
      build({ tokenizer: { ...good, privacyUrl: 'http://privacy-service:4001' } }),
    ).toThrow(/https/);
  });
});
