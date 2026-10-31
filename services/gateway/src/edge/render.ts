import {
  idpChoiceShape,
  idpConfigShape,
  idpEndpoints,
  idpOf,
  signingKeysOf,
  loadConfig,
  modeConfigShape,
  privacyUrlMatchesMode,
  type EnvSource,
} from '@privpay/common';
import { z } from 'zod';
import { buildKongConfig, jwkToPem } from './kong-config';

// DK-02a: what runs once at start, before Kong. The IdP's public key (never a secret) becomes the JWT consumer of
// Kong, so a restart of the dev IdP, which makes a new key each time, only needs this step and Kong to run again.
// Keycloak (DK-04) publishes stable keys; the step stays the same.

const serviceUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.hostname });

// The name of a Docker secret, not a path and not a value: Kong mounts it under /run/secrets, this step does not.
const secretName = z.string().regex(/^[A-Za-z0-9_.-]+$/);

const schema = z
  .object({
    ...modeConfigShape,
    // DK-02b: where the tokenizing plugin reaches Privacy (proposed only), and the paths, inside the Kong container, of the
    // two secret files it reads. The values of those files are never read here.
    PRIVACY_SERVICE_URL: serviceUrl.optional(),
    TOKENIZER_CLIENT_SECRET_NAME: secretName.optional(),
    TOKENIZER_EDGE_SECRET_NAME: secretName.optional(),
    IDP_URL: idpConfigShape.IDP_URL,
    IDP_ISSUER: idpConfigShape.IDP_ISSUER,
    ...idpChoiceShape,
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
  })
  .superRefine(privacyUrlMatchesMode);

const jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });
const FETCH_TIMEOUT_MS = 3000;

async function fetchJwks(idpUrl: string, path: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, idpUrl).toString(), {
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

const mounted = (name: string | undefined): string | undefined =>
  name === undefined ? undefined : `/run/secrets/${name}`;

/** The text of the Kong declarative file for this environment. Errors never repeat key material. */
export async function renderKongConfig(
  env: EnvSource,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const config = loadConfig(schema, env);
  const idp = idpOf(config);
  const answer = await fetchJwks(config.IDP_URL, idpEndpoints(idp).jwks, fetchImpl);
  let body = answer;
  if (idp.kind === 'keycloak') {
    // Keycloak publishes a signing and an encryption key; only the one RS256 signing key is read (ADR-0017).
    try {
      body = signingKeysOf(answer);
    } catch {
      throw new Error('the IdP must publish exactly one signing key');
    }
  }
  const parsed = jwks.safeParse(body);
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
    tokenizer:
      // A Privacy Service is configured exactly when the condition has one (privacyUrlMatchesMode), so its address decides.
      config.PRIVACY_SERVICE_URL === undefined
        ? { action: 'passthrough' }
        : {
            action: 'tokenize',
            privacyUrl: config.PRIVACY_SERVICE_URL,
            idpUrl: config.IDP_URL,
            clientSecretFile: mounted(config.TOKENIZER_CLIENT_SECRET_NAME),
            edgeSecretFile: mounted(config.TOKENIZER_EDGE_SECRET_NAME),
          },
  });
  return JSON.stringify(file, null, 2);
}
