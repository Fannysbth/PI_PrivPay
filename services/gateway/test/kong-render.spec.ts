import { generateKeyPairSync } from 'node:crypto';
import { renderKongConfig } from '../src/edge/render';

// DK-02a: at start the IdP's public key becomes a JWT consumer of Kong. One key only: Kong finds the key by `iss`, so
// two keys under one issuer cannot both be served; the start stops instead of trusting one at random.
const jwk = () => ({
  ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }),
  kid: 'kid-1',
  alg: 'RS256',
  use: 'sig',
});
const ENV = {
  PRIVACY_MODE: 'proposed',
  PRIVACY_SERVICE_URL: 'https://privacy-service:4001',
  TOKENIZER_CLIENT_SECRET_NAME: 'api-gateway_client_secret',
  TOKENIZER_EDGE_SECRET_NAME: 'edge_adapter_secret',
  IDP_URL: 'http://idp:4000',
  KONG_UPSTREAM_URL: 'http://gateway:4010',
};
const keycloakKeys = {
  keys: [
    { kty: 'RSA', kid: 'enc-1', alg: 'RSA-OAEP', use: 'enc', n: 'AQAB', e: 'AQAB', x5c: ['cert'] },
    { ...jwk(), x5c: ['cert'], 'x5t#S256': 'thumb' },
  ],
};
const answer =
  (body: unknown, status = 200): typeof fetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('DK-02a renderKongConfig reads the IdP JWKS and writes the Kong file', () => {
  it('DK-02a makes the consumer from the single RS256 key and the configured issuer', async () => {
    const text = await renderKongConfig(ENV, answer({ keys: [jwk()] }));
    const config = JSON.parse(text) as {
      consumers: { jwt_secrets: { key: string; rsa_public_key: string }[] }[];
    };
    expect(config.consumers[0]?.jwt_secrets[0]).toMatchObject({ key: 'privpay-dev-idp' });
    expect(config.consumers[0]?.jwt_secrets[0]?.rsa_public_key).toMatch(/BEGIN PUBLIC KEY/);
  });

  it('DK-02a asks the IdP for its JWKS at the well-known path and nothing else', async () => {
    const urls: string[] = [];
    const fake = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ keys: [jwk()] })));
    }) as unknown as typeof fetch;
    await renderKongConfig(ENV, fake);
    expect(urls).toEqual(['http://idp:4000/.well-known/jwks.json']);
  });

  it('DK-02a stops when the IdP has no key, two keys, a non-RSA key or a non-RS256 key', async () => {
    const other = { ...jwk(), kid: 'kid-2' };
    await expect(renderKongConfig(ENV, answer({ keys: [] }))).rejects.toThrow(/exactly one/);
    await expect(renderKongConfig(ENV, answer({ keys: [jwk(), other] }))).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      renderKongConfig(ENV, answer({ keys: [{ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }] })),
    ).rejects.toThrow(/RSA/);
    await expect(
      renderKongConfig(ENV, answer({ keys: [{ ...jwk(), alg: 'HS256' }] })),
    ).rejects.toThrow(/RS256/);
  });

  it('DK-02a stops (and says nothing about the key) when the answer is not a JWKS, not 200, or the IdP is away', async () => {
    await expect(renderKongConfig(ENV, answer({ nothing: true }))).rejects.toThrow(/JWKS/);
    await expect(renderKongConfig(ENV, answer({ keys: [jwk()] }, 503))).rejects.toThrow(/503/);
    const away = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(renderKongConfig(ENV, away)).rejects.toThrow(/IdP/);
  });

  it('DK-02a refuses a JWKS that carries a private key', async () => {
    const withPrivate = {
      ...generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }),
      alg: 'RS256',
    };
    await expect(renderKongConfig(ENV, answer({ keys: [withPrivate] }))).rejects.toThrow(/private/);
  });

  it('DK-02a reads the limits from the environment and fails fast on a bad value', async () => {
    const text = await renderKongConfig(
      { ...ENV, KONG_RATE_LIMIT_PER_MINUTE: '40', RATE_LIMIT_ENABLED: 'true' },
      answer({ keys: [jwk()] }),
    );
    expect(text).toContain('"minute": 40');
    const off = await renderKongConfig(
      { ...ENV, RATE_LIMIT_ENABLED: 'false' },
      answer({ keys: [jwk()] }),
    );
    expect(off).not.toContain('rate-limiting');
    await expect(
      renderKongConfig({ ...ENV, KONG_RATE_LIMIT_PER_MINUTE: '0' }, answer({ keys: [jwk()] })),
    ).rejects.toThrow(/KONG_RATE_LIMIT_PER_MINUTE/);
    await expect(renderKongConfig({}, answer({ keys: [jwk()] }))).rejects.toThrow(/IDP_URL/);
  });
});

describe('DK-02b renderKongConfig tells the tokenizing plugin the mode', () => {
  const plugin = (text: string): { config: Record<string, unknown> } | undefined =>
    (
      JSON.parse(text) as { plugins: { name: string; config: Record<string, unknown> }[] }
    ).plugins.find((candidate) => candidate.name === 'privacy-tokenizer');

  it('DK-02b proposed: the plugin gets Privacy and the two secret paths from the environment', async () => {
    const config = plugin(await renderKongConfig(ENV, answer({ keys: [jwk()] })))?.config;
    expect(config).toMatchObject({
      action: 'tokenize',
      privacy_url: 'https://privacy-service:4001',
      client_secret_file: '/run/secrets/api-gateway_client_secret',
      edge_secret_file: '/run/secrets/edge_adapter_secret',
    });
  });

  it('DK-02b baseline: passthrough, and an address of Privacy is refused (ADR-0006)', async () => {
    const baseline = {
      IDP_URL: ENV.IDP_URL,
      KONG_UPSTREAM_URL: ENV.KONG_UPSTREAM_URL,
      PRIVACY_MODE: 'baseline',
    };
    const config = plugin(await renderKongConfig(baseline, answer({ keys: [jwk()] })))?.config;
    expect(config).toEqual({ action: 'passthrough' });
    await expect(
      renderKongConfig(
        { ...baseline, PRIVACY_SERVICE_URL: ENV.PRIVACY_SERVICE_URL },
        answer({ keys: [jwk()] }),
      ),
    ).rejects.toThrow(/PRIVACY_SERVICE_URL/);
  });

  it('DK-02b proposed without the mode, or without a secret path, stops the start', async () => {
    const without = (key: keyof typeof ENV): Record<string, string> =>
      Object.fromEntries(Object.entries(ENV).filter(([name]) => name !== key));
    const noMode = without('PRIVACY_MODE');
    await expect(renderKongConfig(noMode, answer({ keys: [jwk()] }))).rejects.toThrow(
      /PRIVACY_MODE/,
    );
    const noSecret = without('TOKENIZER_EDGE_SECRET_NAME');
    await expect(renderKongConfig(noSecret, answer({ keys: [jwk()] }))).rejects.toThrow(
      /edgeSecretFile/,
    );
  });
});

describe('DK-04 renderKongConfig with Keycloak', () => {
  const keycloak = {
    ...ENV,
    IDP_KIND: 'keycloak',
    IDP_URL: 'http://keycloak:8080',
    IDP_ISSUER: 'http://keycloak:8080/realms/privpay',
  };

  it('DK-04 asks the certs path of the realm, keeps the signing key only, and uses the issuer of the realm', async () => {
    const urls: string[] = [];
    const fake = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify(keycloakKeys)));
    }) as unknown as typeof fetch;
    const config = JSON.parse(await renderKongConfig(keycloak, fake)) as {
      consumers: { jwt_secrets: { key: string }[] }[];
    };
    expect(urls).toEqual(['http://keycloak:8080/realms/privpay/protocol/openid-connect/certs']);
    expect(config.consumers[0]?.jwt_secrets[0]?.key).toBe('http://keycloak:8080/realms/privpay');
  });

  it('DK-04 two signing keys, or none, stop the start', async () => {
    const second = { ...jwk(), kid: 'sig-2' };
    await expect(
      renderKongConfig(keycloak, answer({ keys: [...keycloakKeys.keys, second] })),
    ).rejects.toThrow(/exactly one/);
    await expect(
      renderKongConfig(keycloak, answer({ keys: [keycloakKeys.keys[0]] })),
    ).rejects.toThrow(/exactly one/);
  });
});
