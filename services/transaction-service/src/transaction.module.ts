import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  createHttpClient,
  createLogger,
  createPool,
  createTokenCache,
  DomainError,
  idpJwksSource,
  JwksKeys,
  readSecret,
  RealDelay,
  SERVICE_DBS,
  type Delay,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { loadTransactionConfig } from './config';
import { z } from 'zod';
import {
  HttpFraudClient,
  HttpNotificationClient,
  HttpPrivacyClient,
  ProposedSubjectReferences,
} from './transaction/clients';
import {
  PendingSweeper,
  TransactionProcessor,
  TransactionRepository,
  TransactionReads,
  TransactionReview,
  type FraudClient,
  type NotificationClient,
  type PrivacyStatusClient,
  type SubjectReferencePort,
} from './transaction';
import { TransactionHttp } from './transaction-http';

const TRANSACTION_HTTP = Symbol('TRANSACTION_HTTP');
const OWNED_POOLS = Symbol('OWNED_POOLS');
const PENDING_SWEEPER = Symbol('PENDING_SWEEPER');
/** The service account of Transaction at the IdP (tools/dev-idp registry). */
const CLIENT_ID = 'transaction';
const tokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

@Controller()
class TransactionController {
  constructor(@Inject(TRANSACTION_HTTP) private readonly transactions: TransactionHttp) {}

  // Declared before any route with a path parameter, so `held` is never read as a transaction id.
  @Get('transaction/held')
  held(@Req() req: Request, @Query() query: unknown) {
    return this.transactions.held(req.headers, query);
  }

  // Spec transaction 3.4: also before the parameter routes, so `completed` is never read as a transaction id.
  @Get('transaction/completed')
  completed(@Req() req: Request, @Query() query: unknown) {
    return this.transactions.completed(req.headers, query);
  }

  @Post('transaction/:id/review')
  @HttpCode(200)
  review(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.transactions.decide(req.headers, id, body);
  }

  // 201 for the request that made the transaction, 200 for a replay of it (spec transaction 3.1).
  @Post('transaction')
  async create(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.transactions.create(req.headers, body);
    res.status(result.httpStatus);
    return result.body;
  }
}

/** Ends the pools this module made when the app closes; pools handed in by a test stay with the test. */
@Injectable()
class PoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(OWNED_POOLS) private readonly pools: readonly Pool[]) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.pools.map((pool) => pool.end()));
  }
}

@Module({})
class TransactionModule {}

export interface TransactionOverrides {
  readonly fetch?: typeof fetch;
  readonly pools?: { readonly app: Pool };
  readonly delay?: Delay;
  /** Tests replace the neighbours; production builds the HTTP adapters from the configuration. */
  readonly neighbours?: {
    readonly subjects: SubjectReferencePort;
    readonly fraud: FraudClient;
    readonly notifications: NotificationClient;
    readonly privacy: PrivacyStatusClient;
  };
  readonly logDestination?: { write(line: string): void };
}

/**
 * The module factory of the transaction service. Configuration problems are raised here, so the process stops before
 * it listens.
 */
export function transactionModules(
  overrides: TransactionOverrides = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadTransactionConfig(env);
    const db = SERVICE_DBS.transaction;
    const owned: Pool[] = [];
    let app = overrides.pools?.app;
    if (app === undefined) {
      app = createPool(config, { role: db.app, database: db.database });
      owned.push(app);
    }
    const http: HttpClient = createHttpClient({
      baseUrls: {
        idp: config.IDP_URL,
        'privacy-service': config.PRIVACY_SERVICE_URL,
        'fraud-service': config.FRAUD_SERVICE_URL,
        'notification-service': config.NOTIFICATION_SERVICE_URL,
      },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    const logger = createLogger({
      service: 'transaction-service',
      destination: overrides.logDestination,
    });
    const repository = new TransactionRepository(app);
    const neighbours = overrides.neighbours ?? httpNeighbours(http, env, clock);
    const transactions = new TransactionHttp({
      clock,
      issuer: config.IDP_ISSUER,
      keys: new JwksKeys({
        clock,
        cooldownSeconds: config.JWKS_REFRESH_COOLDOWN_SECONDS,
        maxAgeSeconds: config.JWKS_MAX_AGE_SECONDS,
        source: idpJwksSource(http),
      }),
      processor: new TransactionProcessor({
        repository,
        clock,
        delay: overrides.delay ?? new RealDelay(),
        fraudAmountThreshold: config.FRAUD_AMOUNT_THRESHOLD,
        waitMs: config.HTTP_TIMEOUT_MS,
        ...neighbours,
        logger,
      }),
      review: new TransactionReview({ repository, clock, ...neighbours, logger }),
      reads: new TransactionReads({ repository }),
    });
    // M4-03: built and validated at start; running it on a timer waits for the process lifecycle, like RetentionJob.
    const sweeper = new PendingSweeper({
      repository,
      clock,
      privacy: neighbours.privacy,
      timeoutSeconds: config.TX_PENDING_TIMEOUT_SECONDS,
      logger,
    });
    return [
      {
        module: TransactionModule,
        controllers: [TransactionController],
        providers: [
          { provide: TRANSACTION_HTTP, useValue: transactions },
          { provide: PENDING_SWEEPER, useValue: sweeper },
          { provide: OWNED_POOLS, useValue: owned },
          PoolLifecycle,
        ],
      },
    ];
  };
}

/** One cached service token per service it calls (NFR-21); the secret never leaves this closure. */
function httpNeighbours(
  http: HttpClient,
  env: Readonly<Record<string, string | undefined>>,
  clock: Parameters<typeof createTokenCache>[0]['clock'],
) {
  const clientSecret = readSecret(env, 'TRANSACTION_CLIENT_SECRET');
  const tokenFor = (audience: string): TokenCache =>
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
            client_secret: clientSecret,
            audience: [audience],
          },
          idempotent: true,
        });
        const parsed = tokenAnswer.safeParse(answer.body);
        if (answer.status !== 200 || !parsed.success) {
          throw new DomainError('SERVICE_UNAVAILABLE', 'token');
        }
        return {
          token: parsed.data.access_token,
          expiresAt: new Date(clock.now().getTime() + parsed.data.expires_in * 1000),
        };
      },
    });
  const privacy = new HttpPrivacyClient({ http, serviceToken: tokenFor('privacy-service') });
  return {
    subjects: new ProposedSubjectReferences(privacy),
    privacy,
    fraud: new HttpFraudClient({ http, serviceToken: tokenFor('fraud-service') }),
    notifications: new HttpNotificationClient({
      http,
      serviceToken: tokenFor('notification-service'),
    }),
  };
}
