import 'reflect-metadata';
import {
  Body,
  Controller,
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
  createPool,
  idpJwksSource,
  JwksKeys,
  RealDelay,
  SERVICE_DBS,
  type Delay,
  type HttpClient,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { loadTransactionConfig } from './config';
import { TransactionProcessor, TransactionRepository } from './transaction';
import { TransactionHttp } from './transaction-http';

const TRANSACTION_HTTP = Symbol('TRANSACTION_HTTP');
const OWNED_POOLS = Symbol('OWNED_POOLS');

@Controller()
class TransactionController {
  constructor(@Inject(TRANSACTION_HTTP) private readonly transactions: TransactionHttp) {}

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
      baseUrls: { idp: config.IDP_URL },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
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
        repository: new TransactionRepository(app),
        clock,
        delay: overrides.delay ?? new RealDelay(),
        fraudAmountThreshold: config.FRAUD_AMOUNT_THRESHOLD,
        waitMs: config.HTTP_TIMEOUT_MS,
      }),
    });
    return [
      {
        module: TransactionModule,
        controllers: [TransactionController],
        providers: [
          { provide: TRANSACTION_HTTP, useValue: transactions },
          { provide: OWNED_POOLS, useValue: owned },
          PoolLifecycle,
        ],
      },
    ];
  };
}
