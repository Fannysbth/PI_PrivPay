import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
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
  SERVICE_DBS,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { loadReconciliationConfig, readClientSecret } from './config';
import {
  ReconciliationRepository,
  ReconciliationService,
  type PrivacyClient,
  type TransactionClient,
} from './reconciliation';
import { HttpPrivacyClient, HttpTransactionClient } from './reconciliation/clients';
import { DailyRun } from './reconciliation/schedule';
import { ReconciliationHttp } from './reconciliation-http';

/** The service account of Reconciliation at the IdP (tools/dev-idp registry): Privacy and Transaction only. */
const CLIENT_ID = 'reconciliation';

const RECONCILIATION_HTTP = Symbol('RECONCILIATION_HTTP');
const DAILY_RUN = Symbol('DAILY_RUN');
const OWNED_POOLS = Symbol('OWNED_POOLS');

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().min(1).max(300),
});

@Controller()
class ReconciliationController {
  constructor(@Inject(RECONCILIATION_HTTP) private readonly reconciliation: ReconciliationHttp) {}

  // 202 for the first report of a date, 200 for the same content again (spec reconciliation 3.1, K-22).
  @Post('reconciliation/settlement-report')
  async settlementReport(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reconciliation.settlementReport(req.headers, body);
    res.status(result.created ? 202 : 200);
    return result.body;
  }

  @Post('reconciliation/run')
  @HttpCode(200)
  run(@Req() req: Request, @Body() body: unknown) {
    return this.reconciliation.run(req.headers, body);
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
class ReconciliationModule {}

export interface ReconciliationOverrides {
  readonly fetch?: typeof fetch;
  readonly pools?: { readonly app: Pool };
  /** Replace the adapters, for a test that does not want the network. */
  readonly transactions?: TransactionClient;
  readonly privacy?: PrivacyClient;
  readonly logDestination?: { write(line: string): void };
}

/**
 * The module factory of the reconciliation service. Configuration and secret problems are raised here, so the process
 * stops before it listens.
 */
export function reconciliationModules(
  overrides: ReconciliationOverrides = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadReconciliationConfig(env);
    const db = SERVICE_DBS.reconciliation;
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
        'transaction-service': config.TRANSACTION_SERVICE_URL,
      },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    // A test that replaces both neighbours reaches no service, so it needs no secret; a real start always does.
    const clientSecret =
      overrides.transactions !== undefined && overrides.privacy !== undefined
        ? ''
        : readClientSecret(env);
    // One cached service token per service it calls (NFR-21); the secret never leaves this closure.
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
    const logger = createLogger({
      service: 'reconciliation-service',
      destination: overrides.logDestination,
    });

    const service = new ReconciliationService({
      repository: new ReconciliationRepository(app),
      transactions:
        overrides.transactions ??
        new HttpTransactionClient({ http, serviceToken: tokenFor('transaction-service') }),
      privacy:
        overrides.privacy ??
        new HttpPrivacyClient({ http, serviceToken: tokenFor('privacy-service') }),
      clock,
      logger,
    });
    const reconciliation = new ReconciliationHttp({
      clock,
      issuer: config.IDP_ISSUER,
      keys: new JwksKeys({
        clock,
        cooldownSeconds: config.JWKS_REFRESH_COOLDOWN_SECONDS,
        maxAgeSeconds: config.JWKS_MAX_AGE_SECONDS,
        source: idpJwksSource(http),
      }),
      reconciliation: service,
    });
    // K-23: built and validated at start; running it on a timer waits for the process lifecycle, like RetentionJob.
    const daily = new DailyRun({ service, clock, runUtc: config.RECON_DAILY_RUN_UTC, logger });
    return [
      {
        module: ReconciliationModule,
        controllers: [ReconciliationController],
        providers: [
          { provide: RECONCILIATION_HTTP, useValue: reconciliation },
          { provide: DAILY_RUN, useValue: daily },
          { provide: OWNED_POOLS, useValue: owned },
          PoolLifecycle,
        ],
      },
    ];
  };
}
