import { randomUUID } from 'node:crypto';
import { RealDelay, type Delay } from './delay';
import { DomainError } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface HttpRequest {
  /** A key of `baseUrls`; the caller never supplies a URL (API7). */
  readonly service: string;
  readonly method: HttpMethod;
  /** Absolute path on that service, optionally with a query string. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Only idempotent requests are retried (NFR-12). */
  readonly idempotent: boolean;
  readonly requestId?: string;
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
  readonly delay?: Delay;
  readonly random?: () => number;
  readonly fetch?: typeof fetch;
  readonly backoffBaseMs?: number;
  readonly newRequestId?: () => string;
}

export interface HttpClient {
  /**
   * Resolves with the downstream answer for any final status except 502, 503 and 504, which (like network failures
   * and timeouts) end in `DomainError('SERVICE_UNAVAILABLE')` once the allowed retries are used up.
   */
  request(request: HttpRequest): Promise<HttpResponse>;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RESPONSE_BYTES = 1_048_576;
/** An absolute path; no scheme, no protocol-relative start, no whitespace, backslash or fragment. */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const delay = options.delay ?? new RealDelay();
  const random = options.random ?? Math.random;
  const fetchImpl = options.fetch ?? fetch;
  const backoffBaseMs = options.backoffBaseMs ?? 100;
  const newRequestId = options.newRequestId ?? randomUUID;

  function urlFor(request: HttpRequest): string {
    const base = Object.hasOwn(options.baseUrls, request.service)
      ? options.baseUrls[request.service]
      : undefined;
    if (base === undefined) throw new RangeError('unknown service');
    if (!SAFE_PATH.test(request.path)) throw new RangeError('path is not a plain absolute path');
    return `${base.replace(/\/+$/, '')}${request.path}`;
  }

  /** One attempt. Anything that goes wrong (network, timeout, unreadable body) is a failed attempt, not a crash. */
  async function attempt(url: string, request: HttpRequest, requestId: string) {
    const headers = new Headers(request.headers);
    if (request.body !== undefined) headers.set('content-type', 'application/json');
    headers.set('x-request-id', requestId);
    try {
      const response = await fetchImpl(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (RETRYABLE_STATUSES.has(response.status)) {
        await response.body?.cancel();
        return undefined;
      }
      const text = await readBounded(response);
      return {
        status: response.status,
        body: parseBody(response.headers.get('content-type'), text),
      };
    } catch {
      return undefined;
    }
  }

  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const url = urlFor(request);
      const requestId =
        request.requestId !== undefined && UUID.test(request.requestId)
          ? request.requestId
          : newRequestId();

      for (let tried = 1; ; tried += 1) {
        const outcome = await attempt(url, request, requestId);
        if (outcome !== undefined) return outcome;
        if (!request.idempotent || tried > options.maxRetries) {
          throw new DomainError('SERVICE_UNAVAILABLE');
        }
        // Exponential backoff with jitter between 0.5x and 1.5x of the nominal wait.
        await delay.wait(backoffBaseMs * 2 ** (tried - 1) * (0.5 + random()));
      }
    },
  };
}
