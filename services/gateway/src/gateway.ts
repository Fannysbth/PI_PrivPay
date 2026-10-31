import {
  authenticate,
  DomainError,
  parseBearer,
  RateLimitedError,
  safeEqual,
  unverifiedKid,
  type JwksKeys,
  type AuthHeaders,
  type Authenticated,
  type Clock,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ErrorMasker } from './error-masker';
import type { RateLimiter } from './rate-limiter';
import type { RegistrationFlow } from './registration';
import type { Route, RouteMatch, RouteTable, Upstream } from './routes';
import { EDGE_BODIES, IDEMPOTENCY_KEY } from './tokenizer/schemas';
import type { Tokenizer } from './tokenizer/tokenizer';

export interface GatewayRequest {
  readonly method: string;
  /** The path alone, as the client wrote it (no query string). */
  readonly path: string;
  readonly headers: AuthHeaders;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
  readonly requestId: string;
  /** Where the connection came from: the key of the limit of `POST /register` (K-14). */
  readonly remoteAddress: string;
}

const SIXTEEN_KIB = 16 * 1024;

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
  readonly tokenizer: Tokenizer;
  readonly registration: RegistrationFlow;
  /** The gateway's own service token, one cache per upstream (the token's `aud` is that upstream). */
  readonly serviceTokens: Readonly<Record<Upstream, TokenCache>>;
  /**
   * DK-02b: set when Kong tokenizes before the adapter. The tokenizing routes then take the tokenized shape from a
   * request that proves it came from Kong, and the adapter does not tokenize them (no double tokenizing).
   */
  readonly edge?: { readonly secret: string };
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

    // The one route without a token (gateway spec 6, K-14): counted by where it came from, and checked in full inside.
    if (request.method === 'POST' && request.path === '/register') {
      context.routeTemplate = '/register';
      const decision = limiter.allow(`register:${request.remoteAddress}`);
      if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
      this.assertDeclaredSize(request.headers['content-length'], SIXTEEN_KIB);
      return this.deps.registration.register(request.body ?? {}, request.requestId);
    }

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

    if (!this.mayCall(route, caller)) throw new DomainError('FORBIDDEN_ROLE', 'route_role');

    this.assertSize(route, request.headers['content-length']);
    const query = this.validatedQuery(route, request.query);
    // Gateway spec 4 and 5: the identifiers are replaced by tokens, and only what the tokenizer returns goes on.
    // If it cannot (Privacy away or refusing) it throws and nothing is sent: no fallback to raw data (invariant 8).
    const body = await this.outbound(route, request, caller);

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
            ...(route.auth === 'gateway-token+actor' ? { actorToken: person } : {}),
          }),
    });

    if (response.status < 200 || response.status > 299) {
      throw this.deps.masker.fromDownstream(response.status, response.body);
    }
    // The phone of a customer is changed by AZ-02: the domain token Notification answers with is not the customer's to see.
    if (route.tokenize === 'notification') return { status: 200, body: { status: 'REGISTERED' } };
    return { status: response.status, body: response.body };
  }

  /**
   * The body that goes on. A route without tokenizing sends what validated. A tokenizing route sends what the tokenizer
   * returns, or, behind Kong (DK-02b), the tokenized body Kong made, when the request proves it came from Kong. Behind
   * Kong a request that did not (a client that went round it, or Kong declined) is still checked the way it always was,
   * so a bad one gets the same 422; a good raw one is refused 503, because the adapter no longer tokenizes there and
   * raw identifiers never go on (invariant 8).
   */
  private async outbound(
    route: Route,
    request: GatewayRequest,
    caller: Authenticated,
  ): Promise<unknown> {
    const { edge } = this.deps;
    if (edge !== undefined && route.tokenize !== null && this.fromEdge(request, edge.secret)) {
      const parsed = EDGE_BODIES[route.tokenize].safeParse(request.body ?? {});
      if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'edge_body');
      return parsed.data;
    }
    const validated = this.validatedBody(route, request.body);
    if (route.tokenize === null) return validated;
    if (edge !== undefined) {
      if (route.tokenize === 'transaction') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
          throw new DomainError('VALIDATION_ERROR', 'idempotency_key');
      }
      throw new DomainError('SERVICE_UNAVAILABLE', 'edge_untokenized');
    }
    return (await this.tokenized(route, request, caller, validated)).outbound;
  }

  /** True when the request carries the secret only Kong and the adapter know (Kong overwrites the header on every request). */
  private fromEdge(request: GatewayRequest, secret: string): boolean {
    const presented = request.headers['x-edge-auth'];
    return typeof presented === 'string' && safeEqual(presented, secret);
  }

  /** Who may use the route (gateway spec 3): people by role, a customer with a customer id, or the bank. */
  private mayCall(route: Route, caller: Authenticated): boolean {
    switch (route.caller) {
      case 'customer':
        return caller.requestingService === 'CUSTOMER' && caller.customerId !== undefined;
      case 'bank':
        return caller.requestingService === 'BANK';
      case 'person':
        return (
          caller.requestingService === 'ADMIN_CONSOLE' &&
          caller.actor !== undefined &&
          route.who.includes(caller.actor.role)
        );
    }
  }

  private async tokenized(
    route: Route,
    request: GatewayRequest,
    caller: Authenticated,
    validated: unknown,
  ) {
    if (route.tokenize === 'settlement') {
      return this.deps.tokenizer.tokenize({ route: 'settlement', body: validated });
    }
    if (route.tokenize === 'notification') {
      // The customer is the one in the verified token (invariant 7); the body has the phone and nothing about who.
      return this.deps.tokenizer.tokenize({
        route: 'notification',
        claims: { customerId: caller.customerId ?? '' },
        body: validated,
      });
    }
    const key = request.headers['idempotency-key'];
    // A repeated header arrives as an array or a comma-joined text; neither is a UUID.
    if (typeof key !== 'string') throw new DomainError('VALIDATION_ERROR', 'idempotency_key');
    return this.deps.tokenizer.tokenize({
      route: 'transaction',
      // The customer id comes from the verified token, never from the body (invariant 7).
      claims: { customerId: caller.customerId ?? '' },
      idempotencyKey: key,
      body: validated,
    });
  }

  /** The size the client declared, checked against the route's limit before the body is looked at. */
  private assertSize(route: Route, declared: string | string[] | undefined): void {
    if (route.method === 'GET') return;
    this.assertDeclaredSize(declared, route.maxBodyBytes);
  }

  private assertDeclaredSize(declared: string | string[] | undefined, limit: number): void {
    const length = typeof declared === 'string' ? Number.parseInt(declared, 10) : 0;
    if (Number.isFinite(length) && length > limit) {
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
