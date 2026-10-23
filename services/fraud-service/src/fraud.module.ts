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
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  createHttpClient,
  createServicePool,
  idpJwksSource,
  JwksKeys,
  subjectRefShape,
  type HttpClient,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { loadFraudConfig } from './config';
import { FraudHttp } from './fraud-http';
import { baselineAssessmentRepository } from './baseline';
import { proposedAssessmentRepository } from './proposed';
import { FraudAssessor, RiskEngine } from './risk';

const FRAUD_HTTP = Symbol('FRAUD_HTTP');
const OWNED_POOLS = Symbol('OWNED_POOLS');

@Controller()
class FraudController {
  constructor(@Inject(FRAUD_HTTP) private readonly fraud: FraudHttp) {}

  @Post('fraud/assess')
  @HttpCode(200)
  assess(@Req() req: Request, @Body() body: unknown) {
    return this.fraud.assess(req.headers, body);
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
class FraudModule {}

export interface FraudOverrides {
  readonly fetch?: typeof fetch;
  readonly pools?: { readonly app: Pool };
}

/**
 * The module factory of the fraud service. Configuration problems are raised here, so the process stops before it
 * listens.
 */
export function fraudModules(
  overrides: FraudOverrides = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadFraudConfig(env);
    const owned: Pool[] = [];
    let app = overrides.pools?.app;
    if (app === undefined) {
      app = createServicePool(config, 'fraud');
      owned.push(app);
    }
    const http: HttpClient = createHttpClient({
      baseUrls: { idp: config.IDP_URL },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    const fraud = new FraudHttp({
      clock,
      issuer: config.IDP_ISSUER,
      keys: new JwksKeys({
        clock,
        cooldownSeconds: config.JWKS_REFRESH_COOLDOWN_SECONDS,
        maxAgeSeconds: config.JWKS_MAX_AGE_SECONDS,
        source: idpJwksSource(http),
      }),
      customerRef: subjectRefShape(config.PRIVACY_MODE).customer,
      assessor: new FraudAssessor({
        // ADR-0006: the one place the mode picks the repository; the assessor below is the same code in both.
        repository:
          config.PRIVACY_MODE === 'baseline'
            ? baselineAssessmentRepository(config.PRIVACY_MODE, app)
            : proposedAssessmentRepository(app),
        engine: new RiskEngine(),
        config: {
          amountThreshold: config.FRAUD_AMOUNT_THRESHOLD,
          oddHourStart: config.FRAUD_ODD_HOUR_START,
          oddHourEnd: config.FRAUD_ODD_HOUR_END,
          holdThreshold: config.FRAUD_HOLD_THRESHOLD,
          blockThreshold: config.FRAUD_BLOCK_THRESHOLD,
        },
        historyDays: config.FRAUD_HISTORY_DAYS,
        clock,
      }),
    });
    return [
      {
        module: FraudModule,
        controllers: [FraudController],
        providers: [
          { provide: FRAUD_HTTP, useValue: fraud },
          { provide: OWNED_POOLS, useValue: owned },
          PoolLifecycle,
        ],
      },
    ];
  };
}
