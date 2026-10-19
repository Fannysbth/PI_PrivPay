import {
  authenticate,
  DomainError,
  RateLimitedError,
  type AuthHeaders,
  type Clock,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ErrorMasker } from './error-masker';
import { unverifiedKid, type JwksKeys } from './jwks';
import type { RateLimiter } from './rate-limiter';
import type { Route, RouteTable, Upstream } from './routes';

export interface GatewayRequest {
  readonly method: string;
  /** The path alone, as the client wrote it (no query string). */
  readonly path: string;
  readonly headers: AuthHeaders;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
  readonly requestId: string;
}

export interface GatewayResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface GatewayDependencies {
  readonly clock: Clock;
  readonly issuer: string;
  readonly table: RouteTable;
  readonly limiter: RateLimiter;
  readonly keys: JwksKeys;
  readonly http: HttpClient;
  readonly masker: ErrorMasker;
  /** The gateway's own service token, one cache per upstream (the token's `aud` is that upstream). */
  readonly serviceTokens: Readonly<Record<Upstream, TokenCache>>;
}

const BEARER_PREFIX = /^bearer /i;

/**
 * The core of the gateway for the operations of people (gateway spec 3): find the route, prove who is calling, count
 * the request, check the role, validate what was sent against the route's strict schema, and pass on only what
 * validated, with the credentials the route prescribes. Any failure is a thrown DomainError; the HTTP layer turns it
 * into the uniform client answer (ErrorMasker). A caller is checked before the body is looked at, so the schema is not
 * revealed to someone who may not use the route.
 */
export class Gateway {
  constructor(private readonly deps: GatewayDependencies) {}

  async handle(
    request: GatewayRequest,
    // Where the route template is reported as soon as the route is known, so logs and metrics have it even on errors.
    context: { routeTemplate?: string } = {},
  ): Promise<GatewayResponse> {
    const { table, limiter, keys, clock } = this.deps;

    // A route that is not in the table does not exist: no credentials needed to be told so.
    const match = table.match(request.method, request.path);
    if (match === undefined) throw new DomainError('VALIDATION_ERROR', 'no_route');
    const { route, params } = match;
    context.routeTemplate = route.pattern;

    // Only Authorization is read; an X-Actor-Token or any other header from a client is not part of the contract.
    const authorization = request.headers['authorization'];
    const bearer =
      typeof authorization === 'string' ? authorization.replace(BEARER_PREFIX, '') : undefined;
    await keys.ensure(bearer === undefined ? undefined : unverifiedKid(bearer));
    const caller = authenticate(
      { authorization },
      {
        clock,
        issuer: this.deps.issuer,
        service: 'api-gateway',
        resolveKey: (kid) => keys.resolveKey(kid),
        acceptCustomerToken: true,
      },
    );

    // Counted per caller once the caller is proven; a request refused for its role still counts (FR-26).
    const decision = limiter.allow(`${caller.requestingService}:${caller.subject}`);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    if (
      caller.requestingService !== 'ADMIN_CONSOLE' ||
      caller.actor === undefined ||
      !route.who.includes(caller.actor.role)
    ) {
      throw new DomainError('FORBIDDEN_ROLE', 'route_role');
    }

    const body = this.validatedBody(route, request.body);
    const query = this.validatedQuery(route, request.query);

    const person = bearer as string;
    const response = await this.deps.http.request({
      service: route.upstream,
      method: route.method,
      path: `${this.upstreamPath(route, params)}${this.queryString(request.query, query)}`,
      ...(body === undefined ? {} : { body }),
      idempotent: route.method === 'GET',
      requestId: request.requestId,
      ...(route.auth === 'human-token'
        ? { authorization: `Bearer ${person}` }
        : {
            authorization: `Bearer ${await this.deps.serviceTokens[route.upstream].get()}`,
            actorToken: person,
          }),
    });

    if (response.status < 200 || response.status > 299) {
      throw this.deps.masker.fromDownstream(response.status, response.body);
    }
    return { status: response.status, body: response.body };
  }

  private validatedBody(route: Route, raw: unknown): unknown {
    if (route.method === 'GET') return undefined;
    if (route.body === null) return undefined;
    // No body at all is the same as an empty one, so a route that takes none accepts both and a route that needs
    // fields refuses both.
    const parsed = route.body.safeParse(raw ?? {});
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'body');
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > route.maxBodyBytes) {
      throw new DomainError('VALIDATION_ERROR', 'body_size');
    }
    return parsed.data;
  }

  private validatedQuery(
    route: Route,
    raw: Readonly<Record<string, unknown>>,
  ): Record<string, string> {
    // A route without a query schema takes no query at all.
    const schema = route.query;
    if (schema === null) {
      if (Object.keys(raw).length > 0) throw new DomainError('VALIDATION_ERROR', 'query');
      return {};
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'query');
    return parsed.data as Record<string, string>;
  }

  /** Path parameters were checked against their shape by the route table; the placeholders are replaced as they are. */
  private upstreamPath(route: Route, params: Readonly<Record<string, string>>): string {
    return route.upstreamPath.replace(
      /\{([a-z]+)\}/g,
      (_whole, name: string) => params[name] ?? '',
    );
  }

  /** The query is rebuilt from the validated keys, in the order the client gave them. */
  private queryString(
    raw: Readonly<Record<string, unknown>>,
    validated: Record<string, string>,
  ): string {
    const pairs = Object.keys(raw)
      .filter((key) => Object.hasOwn(validated, key))
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(validated[key] ?? '')}`);
    return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
  }
}
