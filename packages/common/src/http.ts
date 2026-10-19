import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RealDelay, type Delay } from './delay';
import { DomainError } from './errors';
import type { TokenCache } from './token-cache';

/** Timeout and retries come from the environment (NFR-12); the PRD allows at most two retries. */
export const httpConfigSchema = z.object({
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  HTTP_MAX_RETRY: z.coerce.number().int().min(0).max(2).default(2),
});
export type HttpConfig = z.output<typeof httpConfigSchema>;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface HttpRequest {
  /** A key of `baseUrls`; the caller never supplies a URL (API7). */
  readonly service: string;
  readonly method: HttpMethod;
  /** Absolute path on that service, optionally with a query string. */
  readonly path: string;
  readonly body?: unknown;
  /**
   * Only idempotent requests are retried (NFR-12). Idempotent: POST /pseudonymize, POST /resolve-domain,
   * POST /re-issue, PATCH /transaction-status, POST /notification/register, and every GET.
   * Not idempotent: POST /notification/send, POST /fraud/assess, POST /de-pseudonymize, and POST /identity
   * until it is made idempotent (platform-dan-ci.md section 6).
   */
  readonly idempotent: boolean;
  readonly requestId?: string;
  /** Full `Authorization` value (`Bearer ...`), used as is; defaults to the configured service token. */
  readonly authorization?: string;
  /** Verified human token for `X-Actor-Token` (ADR-0007). */
  readonly actorToken?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpClientOptions {
  /** Service name to base URL, taken from configuration only. */
  readonly baseUrls: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** Source of the `Authorization` header when a request does not carry its own. */
  readonly serviceToken?: Pick<TokenCache, 'get'>;
  readonly delay?: Delay;
  readonly random?: () => number;
  readonly fetch?: typeof fetch;
  /** Tests replace this to end a request without waiting for real time. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
  readonly backoffBaseMs?: number;
  readonly newRequestId?: () => string;
}

export interface HttpClient {
  /**
   * Resolves with the downstream answer for any final status except 502, 503 and 504. Those, network failures, and
   * timeouts end in `DomainError('SERVICE_UNAVAILABLE')` once the allowed retries are used up; its `cause` names the
   * category (timeout, network, unavailable, too_large, parse) and never a value. A malformed request (bad path,
   * service, token, or body) is a caller bug and fails with `DomainError('INTERNAL_ERROR')` before anything is sent.
   */
  request(request: HttpRequest): Promise<HttpResponse>;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RESPONSE_BYTES = 1_048_576;
/** An absolute path; no scheme, no protocol-relative start, no whitespace, backslash or fragment. */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
/** `.` and `..` segments (also percent-encoded) could climb out of a base-URL prefix. */
const DOT_SEGMENT = /(^|\/)(\.|\.\.|%2e|%2e%2e)(?=\/|\?|$)/i;
const TOKEN_CHARS = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]{1,4096}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FailureCause = 'timeout' | 'network' | 'unavailable' | 'too_large' | 'parse';
type Outcome =
  | { readonly kind: 'ok'; readonly response: HttpResponse }
  | { readonly kind: 'failed'; readonly cause: FailureCause; readonly retryable: boolean };

class ResponseTooLarge extends Error {}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ResponseTooLarge();
  }
  // undici types the stream chunks loosely; they are bytes.
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(contentType: string | null, text: string): unknown {
  if (text === '') return undefined;
  return contentType?.includes('json') === true ? (JSON.parse(text) as unknown) : text;
}

/** A request the caller built wrongly. No value is put in the error: it could be a token. */
const callerBug = (cause: string): DomainError => new DomainError('INTERNAL_ERROR', cause);

function serialise(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  try {
    // At run time JSON.stringify returns undefined for values JSON cannot represent, despite its declared type.
    const text = JSON.stringify(body) as string | undefined;
    if (text !== undefined) return text;
  } catch {
    // A circular structure or a BigInt lands here; it is reported below without its content.
  }
  throw callerBug('invalid_body');
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const delay = options.delay ?? new RealDelay();
  const random = options.random ?? Math.random;
  const fetchImpl = options.fetch ?? fetch;
  const backoffBaseMs = options.backoffBaseMs ?? 100;
  const newRequestId = options.newRequestId ?? randomUUID;
  const timeoutSignal = options.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  function urlFor(request: HttpRequest): string {
    const base = Object.hasOwn(options.baseUrls, request.service)
      ? options.baseUrls[request.service]
      : undefined;
    if (base === undefined) throw callerBug('unknown_service');
    if (!SAFE_PATH.test(request.path) || DOT_SEGMENT.test(request.path)) {
      throw callerBug('invalid_path');
    }
    return `${base.replace(/\/+$/, '')}${request.path}`;
  }

  async function authorizationFor(request: HttpRequest): Promise<string | undefined> {
    const authorization =
      request.authorization ??
      (options.serviceToken === undefined
        ? undefined
        : `Bearer ${await options.serviceToken.get()}`);
    if (authorization !== undefined && !BEARER.test(authorization)) {
      throw callerBug('invalid_authorization');
    }
    return authorization;
  }

  /** One attempt. Whatever goes wrong becomes a labelled failure, never a crash and never a leaked value. */
  async function attempt(url: string, method: HttpMethod, headers: Headers, body?: string) {
    const signal = timeoutSignal(options.timeoutMs);
    try {
      const response = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal });
      if (RETRYABLE_STATUSES.has(response.status)) {
        await response.body?.cancel();
        return { kind: 'failed', cause: 'unavailable', retryable: true } satisfies Outcome;
      }
      const text = await readBounded(response);
      const parsed = parseBody(response.headers.get('content-type'), text);
      return { kind: 'ok', response: { status: response.status, body: parsed } } satisfies Outcome;
    } catch (error) {
      if (signal.aborted) return { kind: 'failed', cause: 'timeout', retryable: true } as Outcome;
      if (error instanceof ResponseTooLarge) {
        return { kind: 'failed', cause: 'too_large', retryable: false } as Outcome;
      }
      if (error instanceof SyntaxError) {
        return { kind: 'failed', cause: 'parse', retryable: false } as Outcome;
      }
      return { kind: 'failed', cause: 'network', retryable: true } as Outcome;
    }
  }

  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const url = urlFor(request);
      const body = serialise(request.body);
      const authorization = await authorizationFor(request);
      if (request.actorToken !== undefined && !TOKEN_CHARS.test(request.actorToken)) {
        throw callerBug('invalid_actor_token');
      }

      const headers = new Headers();
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (authorization !== undefined) headers.set('authorization', authorization);
      if (request.actorToken !== undefined) headers.set('x-actor-token', request.actorToken);
      headers.set(
        'x-request-id',
        request.requestId !== undefined && UUID.test(request.requestId)
          ? request.requestId
          : newRequestId(),
      );

      for (let tried = 1; ; tried += 1) {
        const outcome: Outcome = await attempt(url, request.method, headers, body);
        if (outcome.kind === 'ok') return outcome.response;
        if (!outcome.retryable || !request.idempotent || tried > options.maxRetries) {
          throw new DomainError('SERVICE_UNAVAILABLE', outcome.cause);
        }
        // Exponential backoff with jitter between 0.5x and 1.5x of the nominal wait.
        await delay.wait(backoffBaseMs * 2 ** (tried - 1) * (0.5 + random()));
      }
    },
  };
}
