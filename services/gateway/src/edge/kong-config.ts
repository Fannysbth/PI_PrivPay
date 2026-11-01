import { createPublicKey, type JsonWebKey } from 'node:crypto';
import { DomainError, REASONS, toClientError } from '@privpay/common';

// DK-02a: the declarative (DB-less) configuration of Kong 3.9.4 OSS, which stands in front of the gateway adapter at the
// edge (Metodologi, Tabel III). Kong keeps what a generic proxy can do: TLS, token signature and expiry, request size,
// request rate. The adapter keeps what is specific to PrivPay: audience, client and role per route, schemas,
// tokenizing, the registration saga (gateway spec 3 to 6). The file is built at start from the IdP's public key, so no
// secret and no literal key sits in the repository.

export interface KongConfigInput {
  /** The IdP's public key (PEM). Never a private key. */
  readonly publicKeyPem: string;
  /** The `iss` claim of the IdP; Kong finds the key by it. */
  readonly issuer: string;
  /** Where the adapter listens on the internal network. */
  readonly upstreamUrl: string;
  readonly rateLimit: { readonly enabled: boolean; readonly perMinute: number };
  /** The largest body Kong lets through; the adapter's per-route limits (16 or 64 KiB) apply under it. */
  readonly maxPayloadBytes: number;
  /** ADR-0007 item 7: an access token lives at most this many seconds. */
  readonly maxTokenLifetimeSeconds: number;
  /** DK-02b: the tokenizing plugin. */
  readonly tokenizer: TokenizerInput;
}

/**
 * passthrough: the plugin is told nothing else and so cannot reach Privacy. tokenize: the places the plugin
 * needs. The two secrets are paths of files that Kong mounts (never values), Privacy is reached over TLS only.
 */
export type TokenizerInput =
  | { readonly action: 'passthrough' }
  | {
      readonly action: 'tokenize';
      readonly privacyUrl?: string | undefined;
      readonly idpUrl?: string | undefined;
      /** Where and how the IdP wants the token request (DK-04): the dev IdP takes JSON at /token, Keycloak a form at its realm. */
      readonly idpTokenPath?: string | undefined;
      readonly idpForm?: boolean | undefined;
      readonly clientSecretFile?: string | undefined;
      readonly edgeSecretFile?: string | undefined;
    };

/** A public JWK as a PEM. A JWK with private parameters is refused: Kong needs the public key only. */
export function jwkToPem(jwk: JsonWebKey): string {
  if (jwk.d !== undefined || jwk.p !== undefined || jwk.q !== undefined) {
    throw new Error('the JWK carries private parameters; only a public key is accepted');
  }
  return createPublicKey({ key: jwk, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

const positive = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a whole number, at least 1`);
  }
};

// The six codes Kong itself can produce, with the status and message the adapter would use (ADR-0008, NFR-25). Read
// from the same table as the adapter's answers, so the two cannot drift apart.
const KONG_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  ACCESS_DENIED: 'FORBIDDEN_ROLE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

const SAFE_MESSAGE = /^[A-Za-z0-9 .,]+$/;

function codeTable(): string {
  const lines = Object.entries(KONG_CODES).map(([code, reason]) => {
    const { status, body } = toClientError(new DomainError(reason, 'edge'), '0'.repeat(32));
    // The message goes into a Lua string and a JSON string by plain concatenation; keep it to characters needing no escape.
    if (!SAFE_MESSAGE.test(body.error.message))
      throw new Error(`message of ${code} needs escaping`);
    return `  ${code} = { ${String(status)}, "${body.error.message}" },`;
  });
  return `local ERRORS = {\n${lines.join('\n')}\n}`;
}

/**
 * Lua for the `post-function` plugin (Kong OSS). Kong's own refusals (401 from jwt, 413 from the size limit, 429 from
 * the rate limit, 502 when the adapter is away) have Kong's shape; here they take the one shape of ADR-0008 so a client
 * cannot tell which layer refused. Answers that come from the adapter (source "service") are never touched.
 */
function errorMapperLua(): { header: string; body: string } {
  const header = `${codeTable()}
local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"
local status = kong.response.get_status()
if status < 400 or kong.response.get_source() == "service" then return end
local name
if status == 401 then name = "UNAUTHENTICATED"
elseif status == 403 then name = "ACCESS_DENIED"
elseif status == 429 then name = "RATE_LIMITED"
elseif status == 502 or status == 503 or status == 504 then name = "SERVICE_UNAVAILABLE"
elseif status >= 500 then name = "INTERNAL_ERROR"
else name = "VALIDATION_ERROR" end
local entry = ERRORS[name]
local id = kong.request.get_header("x-request-id")
if not (id and id:match(UUID)) then
  local raw = kong.request.get_id() or ""
  id = raw:sub(1, 8) .. "-" .. raw:sub(9, 12) .. "-" .. raw:sub(13, 16) .. "-" .. raw:sub(17, 20) .. "-" .. raw:sub(21, 32)
  if not id:match(UUID) then id = "[INVALID]" end
end
kong.response.set_status(entry[1])
kong.response.set_header("Content-Type", "application/json; charset=utf-8")
kong.response.set_header("Cache-Control", "no-store")
kong.response.clear_header("Content-Length")
ngx.ctx.privpay_edge_error = '{"error":{"code":"' .. name .. '","message":"' .. entry[2] .. '","request_id":"' .. id .. '"}}'`;
  const body = `if ngx.ctx.privpay_edge_error then
  ngx.arg[1] = ngx.ctx.privpay_edge_error
  ngx.arg[2] = true
end`;
  return { header, body };
}

type Plugin = { name: string; config?: Record<string, unknown> };

/** Reason of Privacy -> the HTTP status a client sees (ADR-0008), from the same table as the adapter's answers. */
function reasonStatuses(): Record<string, number> {
  return Object.fromEntries(
    (Object.keys(REASONS) as (keyof typeof REASONS)[]).map((reason) => [
      reason,
      toClientError(new DomainError(reason, 'edge'), '0'.repeat(32)).status,
    ]),
  );
}

function tokenizerPlugin(input: TokenizerInput): Plugin {
  if (input.action === 'passthrough') {
    return { name: 'privacy-tokenizer', config: { action: 'passthrough' } };
  }
  const needs = {
    privacyUrl: input.privacyUrl,
    idpUrl: input.idpUrl,
    clientSecretFile: input.clientSecretFile,
    edgeSecretFile: input.edgeSecretFile,
  };
  for (const [name, value] of Object.entries(needs)) {
    if (value === undefined || value === '')
      throw new RangeError(`tokenizer ${name} is required to tokenize`);
  }
  if (!input.privacyUrl?.startsWith('https://')) {
    throw new RangeError('tokenizer privacyUrl must be https (NFR-06)');
  }
  return {
    name: 'privacy-tokenizer',
    config: {
      action: 'tokenize',
      // No trailing slash: the plugin appends /pseudonymize.
      privacy_url: input.privacyUrl.replace(/\/+$/, ''),
      idp_url: input.idpUrl,
      idp_token_path: input.idpTokenPath ?? '/token',
      idp_form: input.idpForm ?? false,
      client_secret_file: input.clientSecretFile,
      edge_secret_file: input.edgeSecretFile,
      reasons: reasonStatuses(),
    },
  };
}

/** The Kong declarative configuration (format 3.0) as a plain object; the caller writes it as JSON. */
export function buildKongConfig(input: KongConfigInput): Record<string, unknown> {
  positive('rate limit per minute', input.rateLimit.perMinute);
  positive('maximum payload bytes', input.maxPayloadBytes);
  positive('maximum token lifetime', input.maxTokenLifetimeSeconds);

  const jwt: Plugin = {
    name: 'jwt',
    config: {
      key_claim_name: 'iss',
      claims_to_verify: ['exp'],
      maximum_expiration: input.maxTokenLifetimeSeconds,
      // Only the Authorization header carries a token. A token in a URL or a cookie is not read (project rules).
      header_names: ['authorization'],
      uri_param_names: [],
      cookie_names: [],
    },
  };
  const common = { protocols: ['https'], strip_path: false, preserve_host: false } as const;
  const mapper = errorMapperLua();

  const globalPlugins: Plugin[] = [
    // Each request carries one id from the edge on; the adapter keeps it when it is a UUID.
    {
      name: 'correlation-id',
      config: { header_name: 'x-request-id', generator: 'uuid', echo_downstream: true },
    },
    {
      name: 'request-size-limiting',
      config: {
        allowed_payload_size: input.maxPayloadBytes,
        size_unit: 'bytes',
        require_content_length: false,
      },
    },
    ...(input.rateLimit.enabled
      ? [
          {
            name: 'rate-limiting',
            // A coarse flood guard per client address. The adapter still counts per caller (FR-26) and per address for /register (K-14).
            config: { minute: input.rateLimit.perMinute, limit_by: 'ip', policy: 'local' },
          },
        ]
      : []),
    // Runs after the JWT plugin (priority 800 < 1450): it reads the claims the JWT plugin has verified (DK-02b).
    tokenizerPlugin(input.tokenizer),
    { name: 'prometheus' },
    {
      name: 'post-function',
      config: { header_filter: [mapper.header], body_filter: [mapper.body] },
    },
  ];

  return {
    _format_version: '3.0',
    services: [
      {
        name: 'gateway-adapter',
        url: input.upstreamUrl,
        // A retry inside Kong could repeat a payment; the adapter has its own idempotency and retry rules (NFR-12).
        retries: 0,
        connect_timeout: 3000,
        read_timeout: 30_000,
        write_timeout: 30_000,
        routes: [
          // The one call without a token (gateway spec 6); the adapter counts it per address and checks the form in full.
          { name: 'register', methods: ['POST'], paths: ['~/register$'], ...common },
          // Answered by Kong itself, status only: the mode is not told to the outside (N-54b); /metrics is not offered either.
          {
            name: 'health',
            methods: ['GET'],
            paths: ['~/health$'],
            ...common,
            plugins: [
              {
                name: 'request-termination',
                config: {
                  status_code: 200,
                  content_type: 'application/json',
                  body: '{"status":"ok"}',
                },
              },
            ],
          },
          {
            name: 'metrics-blocked',
            paths: ['~/(?i)metrics/*$'],
            ...common,
            plugins: [jwt, { name: 'request-termination', config: { status_code: 404 } }],
          },
          { name: 'api', paths: ['/'], ...common, plugins: [jwt] },
        ],
      },
    ],
    consumers: [
      {
        username: 'identity-provider',
        jwt_secrets: [
          { key: input.issuer, algorithm: 'RS256', rsa_public_key: input.publicKeyPem },
        ],
      },
    ],
    plugins: globalPlugins,
  };
}
