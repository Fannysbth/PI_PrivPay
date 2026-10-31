import { idpConfigShape, loadConfig, type EnvSource } from '@privpay/common';
import { z } from 'zod';
import { buildKongConfig, jwkToPem } from './kong-config';

// DK-02a: what runs once at start, before Kong. The IdP's public key (never a secret) becomes the JWT consumer of
// Kong, so a restart of the dev IdP, which makes a new key each time, only needs this step and Kong to run again.
// Keycloak (DK-04) publishes stable keys; the step stays the same.

const serviceUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.hostname });

const schema = z.object({
  IDP_URL: idpConfigShape.IDP_URL,
  IDP_ISSUER: idpConfigShape.IDP_ISSUER,
  KONG_UPSTREAM_URL: serviceUrl,
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Above the adapter's own limit (RATE_LIMIT_PER_MINUTE, per caller): Kong's is a flood guard per client address.
  KONG_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  // The largest body of any route (settlement, 64 KiB; gateway spec 3).
  KONG_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1).default(65_536),
  // ADR-0007 item 7.
  ACCESS_TOKEN_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
});

const jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });
const FETCH_TIMEOUT_MS = 3000;

async function fetchJwks(idpUrl: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('/.well-known/jwks.json', idpUrl).toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('the IdP could not be reached for its JWKS');
  }
  if (response.status !== 200)
    throw new Error(`the IdP answered ${String(response.status)} for its JWKS`);
  return response.json().catch(() => {
    throw new Error('the IdP answer is not JSON (JWKS expected)');
  });
}

/** The text of the Kong declarative file for this environment. Errors never repeat key material. */
export async function renderKongConfig(
  env: EnvSource,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const config = loadConfig(schema, env);
  const parsed = jwks.safeParse(await fetchJwks(config.IDP_URL, fetchImpl));
  if (!parsed.success) throw new Error('the IdP answer is not a JWKS');
  const [key, ...rest] = parsed.data.keys;
  if (key === undefined || rest.length > 0) {
    // Kong finds the key by `iss`; two keys under one issuer cannot both be served.
    throw new Error('the IdP must publish exactly one signing key');
  }
  if (key['kty'] !== 'RSA') throw new Error('the signing key must be an RSA key');
  if (key['alg'] !== 'RS256') throw new Error('the signing key must be for RS256');

  const file = buildKongConfig({
    publicKeyPem: jwkToPem(key),
    issuer: config.IDP_ISSUER,
    upstreamUrl: config.KONG_UPSTREAM_URL,
    rateLimit: { enabled: config.RATE_LIMIT_ENABLED, perMinute: config.KONG_RATE_LIMIT_PER_MINUTE },
    maxPayloadBytes: config.KONG_MAX_PAYLOAD_BYTES,
    maxTokenLifetimeSeconds: config.ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  });
  return JSON.stringify(file, null, 2);
}
