import 'reflect-metadata';
import { All, Controller, Inject, Module, Req, Res } from '@nestjs/common';
import {
  createHttpClient,
  createTokenCache,
  DomainError,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { loadGatewayConfig } from './config';
import { ErrorMasker } from './error-masker';
import { Gateway } from './gateway';
import { JwksKeys } from './jwks';
import { RateLimiter } from './rate-limiter';
import { RouteTable, type Route, type Upstream } from './routes';

const GATEWAY = Symbol('GATEWAY');
const CLIENT_ID = 'api-gateway';
const UPSTREAMS: readonly Upstream[] = [
  'privacy-service',
  'transaction-service',
  'reconciliation-service',
];

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().min(1).max(300),
});

@Controller()
class GatewayController {
  constructor(@Inject(GATEWAY) private readonly gateway: Gateway) {}

  // The route table decides what exists. This one handler receives everything the other controllers (health,
  // metrics) did not claim and hands it to the gateway, which answers "no such route" itself.
  @All('{*path}')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const requestId = typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : '';
    // Counted under one label until a route matches; the gateway replaces it with the route's template.
    const context: { routeTemplate?: string } = {};
    res.locals['routeTemplate'] = '/unmatched';
    const named = (): void => {
      if (context.routeTemplate !== undefined) res.locals['routeTemplate'] = context.routeTemplate;
    };
    let answer;
    try {
      answer = await this.gateway.handle(
        {
          method: req.method,
          path: req.originalUrl.split('?')[0] ?? '',
          headers: req.headers,
          query: req.query,
          body: req.body as unknown,
          requestId,
        },
        context,
      );
    } finally {
      named();
    }
    const empty = answer.body === undefined || answer.body === null || answer.body === '';
    // The services answer JSON. Anything else is a fault upstream and is not passed on to a client (it could be
    // rendered as a page).
    if (!empty && typeof answer.body !== 'object')
      throw new DomainError('INTERNAL_ERROR', 'non_json_upstream');
    res.status(answer.status);
    if (empty) res.end();
    else res.json(answer.body);
  }
}

@Module({})
class GatewayModule {}

/**
 * The module factory for the gateway service. `overrides.fetch` lets tests replace the network; production uses the
 * real one. Configuration problems are ConfigErrors, so the process stops before it listens.
 */
export function gatewayModules(
  overrides: { fetch?: typeof fetch; routes?: readonly Route[] } = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadGatewayConfig(env);
    const http: HttpClient = createHttpClient({
      baseUrls: {
        idp: config.IDP_URL,
        'privacy-service': config.PRIVACY_SERVICE_URL,
        'transaction-service': config.TRANSACTION_SERVICE_URL,
        'reconciliation-service': config.RECONCILIATION_SERVICE_URL,
      },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });

    const tokenFor = (upstream: Upstream): TokenCache =>
      createTokenCache({
        clock,
        fetchToken: async () => {
          const answer = await http.request({
            service: 'idp',
            method: 'POST',
            path: '/token',
            body: {
              grant_type: 'client_credentials',
              client_id: CLIENT_ID,
              client_secret: config.clientSecret,
              audience: [upstream],
            },
            idempotent: true,
          });
          const parsed = tokenAnswer.safeParse(answer.body);
          if (answer.status !== 200 || !parsed.success)
            throw new DomainError('SERVICE_UNAVAILABLE', 'token');
          return {
            token: parsed.data.access_token,
            expiresAt: new Date(clock.now().getTime() + parsed.data.expires_in * 1000),
          };
        },
      });

    const gateway = new Gateway({
      clock,
      issuer: config.IDP_ISSUER,
      table: new RouteTable(overrides.routes),
      limiter: new RateLimiter({
        clock,
        limitPerMinute: config.RATE_LIMIT_PER_MINUTE,
        enabled: config.RATE_LIMIT_ENABLED,
      }),
      keys: new JwksKeys({
        clock,
        cooldownSeconds: config.JWKS_REFRESH_COOLDOWN_SECONDS,
        maxAgeSeconds: config.JWKS_MAX_AGE_SECONDS,
        source: {
          fetch: async () => {
            const answer = await http.request({
              service: 'idp',
              method: 'GET',
              path: '/.well-known/jwks.json',
              idempotent: true,
            });
            if (answer.status !== 200) throw new DomainError('SERVICE_UNAVAILABLE', 'jwks');
            return answer.body;
          },
        },
      }),
      http,
      masker: new ErrorMasker(),
      serviceTokens: Object.fromEntries(
        UPSTREAMS.map((upstream) => [upstream, tokenFor(upstream)]),
      ) as Record<Upstream, TokenCache>,
    });

    return [
      {
        module: GatewayModule,
        controllers: [GatewayController],
        providers: [{ provide: GATEWAY, useValue: gateway }],
      },
    ];
  };
}
