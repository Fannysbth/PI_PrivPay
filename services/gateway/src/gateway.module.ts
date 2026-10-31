import 'reflect-metadata';
import { All, Controller, Inject, Module, Req, Res } from '@nestjs/common';
import {
  createHttpClient,
  createLogger,
  createIdpTokenCache,
  idpJwksSource,
  idpOf,
  JwksKeys,
  privacyBaseUrl,
  subjectRefShape,
  DomainError,
  type Clock,
  type HttpClient,
  type IdpChoice,
  type TokenCache,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request, Response } from 'express';
import { loadGatewayConfig } from './config';
import { devIdpUserDirectory, keycloakUserDirectory, type UserDirectory } from './user-directory';
import { clientAddress } from './edge/client-address';
import { baselinePrivacyPort } from './baseline';
import { ErrorMasker } from './error-masker';
import { Gateway } from './gateway';
import { RateLimiter } from './rate-limiter';
import { RegistrationFlow } from './registration';
import { RouteTable, type Route, type Upstream } from './routes';
import { HttpPrivacyPort } from './tokenizer/http-privacy-port';
import { Tokenizer } from './tokenizer/tokenizer';
import { TransactionIdGenerator } from './tokenizer/transaction-id';

const GATEWAY = Symbol('GATEWAY');
const EDGE_PROXY_HOPS = Symbol('EDGE_PROXY_HOPS');
const CLIENT_ID = 'api-gateway';
/** The audience of the dev IdP's admin API (tools/dev-idp): only the Gateway may ask for it (AZ-38, AZ-39). */
const DEV_IDP = 'dev-idp';
const UPSTREAMS: readonly Upstream[] = [
  'privacy-service',
  'transaction-service',
  'reconciliation-service',
  'notification-service',
];

/** Step A2 of the registration at the IdP in use: Keycloak through its Admin API (client idp-admin), else the dev IdP. */
function userDirectoryFor(
  config: ReturnType<typeof loadGatewayConfig>,
  idp: IdpChoice,
  http: HttpClient,
  clock: Clock,
  devAdminToken: () => TokenCache,
): UserDirectory {
  if (config.keycloakAdmin === undefined) {
    return devIdpUserDirectory({ http, token: devAdminToken() });
  }
  return keycloakUserDirectory({
    http,
    realm: idp.realm,
    userPassword: config.keycloakAdmin.userPassword,
    token: createIdpTokenCache({
      http,
      clock,
      idp,
      grant: {
        type: 'client-credentials',
        clientId: 'idp-admin',
        clientSecret: config.keycloakAdmin.adminClientSecret,
      },
    }),
  });
}

@Controller()
class GatewayController {
  constructor(
    @Inject(GATEWAY) private readonly gateway: Gateway,
    @Inject(EDGE_PROXY_HOPS) private readonly proxyHops: number,
  ) {}

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
          // DK-02a, K-14: behind Kong the socket is Kong's; the client is the address Kong appended (EDGE_PROXY_HOPS=1).
          remoteAddress: clientAddress({
            socket: req.ip ?? '',
            forwardedFor: req.headers['x-forwarded-for'],
            proxyHops: this.proxyHops,
          }),
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
    // An answer through the Gateway may carry an identity (the opening of an audit, FR-43), a token or a decision: no cache,
    // browser or proxy, keeps any of them. The services set it too; this one covers what reaches a client.
    res.setHeader('Cache-Control', 'no-store');
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
  overrides: {
    fetch?: typeof fetch;
    routes?: readonly Route[];
    logDestination?: { write(line: string): void };
  } = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadGatewayConfig(env);
    const http: HttpClient = createHttpClient({
      baseUrls: {
        idp: config.IDP_URL,
        ...privacyBaseUrl(config.PRIVACY_SERVICE_URL),
        'transaction-service': config.TRANSACTION_SERVICE_URL,
        'reconciliation-service': config.RECONCILIATION_SERVICE_URL,
        'notification-service': config.NOTIFICATION_SERVICE_URL,
      },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });

    const idp = idpOf(config);
    const tokenFor = (upstream: Upstream | typeof DEV_IDP): TokenCache =>
      createIdpTokenCache({
        http,
        clock,
        idp,
        grant: {
          type: 'client-credentials',
          clientId: CLIENT_ID,
          clientSecret: config.clientSecret,
          audience: upstream,
        },
      });

    // Keycloak ignores the audience asked for (ADR-0017): one token names every service the account may call, so one cache
    // serves all upstreams instead of five identical token requests.
    const sharedKeycloakToken = idp.kind === 'keycloak' ? tokenFor('privacy-service') : undefined;
    const serviceTokens = Object.fromEntries(
      UPSTREAMS.map((upstream) => [upstream, sharedKeycloakToken ?? tokenFor(upstream)]),
    ) as Record<Upstream, TokenCache>;
    const users = userDirectoryFor(config, idp, http, clock, () => tokenFor(DEV_IDP));
    const masker = new ErrorMasker();
    const ids = new TransactionIdGenerator(clock);

    // ADR-0006: the one place the mode picks the port; the tokenizer and the registration below are the same code.
    const privacy =
      config.PRIVACY_MODE === 'baseline'
        ? baselinePrivacyPort(config.PRIVACY_MODE)
        : new HttpPrivacyPort({ http, masker, serviceToken: serviceTokens['privacy-service'] });
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
        source: idpJwksSource(http, idp),
      }),
      http,
      masker,
      tokenizer: new Tokenizer({
        privacy,
        newTransactionId: () => ids.generate(),
        forwardClientIdentity: config.PRIVACY_MODE === 'baseline',
      }),
      registration: new RegistrationFlow({
        http,
        privacy,
        masker,
        domainRef: subjectRefShape(config.PRIVACY_MODE).customer,
        users,
        notificationToken: serviceTokens['notification-service'],
        logger: createLogger({ service: 'gateway', destination: overrides.logDestination }),
      }),
      serviceTokens,
      ...(config.edgeSecret === undefined ? {} : { edge: { secret: config.edgeSecret } }),
    });

    return [
      {
        module: GatewayModule,
        controllers: [GatewayController],
        providers: [
          { provide: GATEWAY, useValue: gateway },
          { provide: EDGE_PROXY_HOPS, useValue: config.EDGE_PROXY_HOPS },
        ],
      },
    ];
  };
}
