import {
  authenticate,
  DomainError,
  parseBearer,
  RateLimitedError,
  type AuthHeaders,
  type Clock,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ErrorMasker } from './error-masker';
import { unverifiedKid, type JwksKeys } from './jwks';
import type { RateLimiter } from './rate-limiter';
import type { Route, RouteMatch, RouteTable, Upstream } from './routes';

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

/**
 * The core of the gateway for the operations of people (gateway spec 3). Every call first proves who is calling (401
 * for no, expired or forged proof), so what the gateway answers before that says nothing about which routes exist.
 * Then, in this order: the request is counted against its caller (429), the route must exist (422), the role must be
 * allowed on it (403), and what was sent must fit the route's strict schemas (422). Only what validated is passed
 * on, with the credentials the route prescribes. Any failure is a thrown DomainError; the HTTP layer turns it into
 * the uniform client answer (ErrorMasker). A caller is checked before the body is looked at, so the schema is not
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

    // Looked up first only to label the request in the (internal) metrics; nothing is decided from it yet.
    const match = table.match(request.method, request.path);
    if (match !== undefined) context.routeTemplate = match.route.pattern;

    // Only Authorization is read; an X-Actor-Token or any other header from a client is not part of the contract.
    const authorization = request.headers['authorization'];
    const person = parseBearer(typeof authorization === 'string' ? authorization : undefined);
    // Without a token there is nothing to look up: the IdP is not asked for keys on behalf of an anonymous caller.
    if (person !== undefined) await keys.ensure(unverifiedKid(person));
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

    // Counted per caller once the caller is proven; a request refused for its route or role still counts (FR-26).
    const decision = limiter.allow(`${caller.requestingService}:${caller.subject}`);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    // A route that is not in the table does not exist.
    if (match === undefined || person === undefined)
      throw new DomainError('VALIDATION_ERROR', 'no_route');
    const { route } = match;

    if (
      caller.requestingService !== 'ADMIN_CONSOLE' ||
      caller.actor === undefined ||
      !route.who.includes(caller.actor.role)
    ) {
      throw new DomainError('FORBIDDEN_ROLE', 'route_role');
    }

    this.assertSize(route, request.headers['content-length']);
    const body = this.validatedBody(route, request.body);
    const query = this.validatedQuery(route, request.query);

    const response = await this.deps.http.request({
      service: route.upstream,
      method: route.method,
      path: `${this.upstreamPath(route, match)}${this.queryString(query)}`,
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

  /** The size the client declared, checked against the route's limit before the body is looked at. */
  private assertSize(route: Route, declared: string | string[] | undefined): void {
    if (route.method === 'GET') return;
    const length = typeof declared === 'string' ? Number.parseInt(declared, 10) : 0;
    if (Number.isFinite(length) && length > route.maxBodyBytes) {
      throw new DomainError('VALIDATION_ERROR', 'body_size');
    }
  }

  private validatedBody(route: Route, raw: unknown): unknown {
    if (route.method === 'GET') return undefined;
    if (route.body === null) return undefined;
    // No body at all is the same as an empty one, so a route that takes none accepts both and a route that needs
    // fields refuses both. A body that was not JSON never reaches here as a value: the parser leaves it undefined.
    const parsed = route.body.safeParse(raw ?? {});
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'body');
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > route.maxBodyBytes) {
      throw new DomainError('VALIDATION_ERROR', 'body_size');
    }
    return parsed.data;
  }

  /** The query as validated pairs, in the order the client gave them. */
  private validatedQuery(
    route: Route,
    raw: Readonly<Record<string, unknown>>,
  ): readonly (readonly [string, string])[] {
    // A route without a query schema takes no query at all.
    const schema = route.query;
    if (schema === null) {
      if (Object.keys(raw).length > 0) throw new DomainError('VALIDATION_ERROR', 'query');
      return [];
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'query');
    // The schema is strict and every value a string, so the keys of `raw` are exactly the validated ones.
    return Object.entries(raw).map(([key, value]) => [key, String(value)] as const);
  }

  /** Path parameters were checked against their shape by the route table; the placeholders are replaced as they are. */
  private upstreamPath(route: Route, match: RouteMatch): string {
    return route.upstreamPath.replace(
      /\{([a-z]+)\}/g,
      (_whole, name: string) => match.params[name] ?? '',
    );
  }

  private queryString(pairs: readonly (readonly [string, string])[]): string {
    if (pairs.length === 0) return '';
    return `?${pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
  }
}
