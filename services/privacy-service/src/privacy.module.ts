import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Patch,
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
  SERVICE_DBS,
  type HttpClient,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { AuditedOperation, AuditWriter } from './audit';
import { loadPrivacyConfig } from './config';
import { BlindIndex, FieldCipher, TokenMint, loadKeys, type PrivacyKeys } from './crypto';
import { IdentityVault } from './identity';
import { PolicyEngine } from './policy';
import { PrivacyHttp } from './privacy-http';
import { TokenService, TransactionStatusService } from './token';

const PRIVACY_HTTP = Symbol('PRIVACY_HTTP');
const OWNED_POOLS = Symbol('OWNED_POOLS');

@Controller()
class PrivacyController {
  constructor(@Inject(PRIVACY_HTTP) private readonly privacy: PrivacyHttp) {}

  @Post('pseudonymize')
  @HttpCode(200)
  pseudonymize(@Req() req: Request, @Body() body: unknown) {
    return this.privacy.pseudonymize(req.headers, body);
  }

  @Post('re-issue')
  @HttpCode(200)
  reIssue(@Req() req: Request, @Body() body: unknown) {
    return this.privacy.reIssue(req.headers, body);
  }

  @Post('identity')
  async identity(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const stored = await this.privacy.storeIdentity(req.headers, body);
    res.status(stored.created ? 201 : 200);
    return stored.body;
  }

  @Patch('transaction-status')
  @HttpCode(200)
  transactionStatus(@Req() req: Request, @Body() body: unknown) {
    return this.privacy.transactionStatus(req.headers, body);
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
class PrivacyModule {}

export interface PrivacyOverrides {
  readonly fetch?: typeof fetch;
  readonly pools?: { readonly app: Pool };
  readonly keys?: PrivacyKeys;
}

/**
 * The module factory of the privacy service. Configuration, key and secret problems are raised here, so the process
 * stops before it listens (spec privacy 3, FR-30).
 */
export function privacyModules(
  overrides: PrivacyOverrides = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadPrivacyConfig(env);
    const keys = overrides.keys ?? loadKeys(env);
    const db = SERVICE_DBS.privacy;
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
    const policy = new PolicyEngine({
      PAYMENT_PROCESSING: config.TTL_PAYMENT_PROCESSING,
      FRAUD_DETECTION: config.TTL_FRAUD_DETECTION,
      NOTIFICATION: config.TTL_NOTIFICATION,
      NOTIFICATION_REGISTRATION: config.TTL_NOTIFICATION_REGISTRATION,
      DAILY_RECONCILIATION: config.TTL_DAILY_RECONCILIATION,
      INTERNAL_AUDIT: config.TTL_INTERNAL_AUDIT,
    });
    const privacy = new PrivacyHttp({
      clock,
      issuer: config.IDP_ISSUER,
      keys: new JwksKeys({
        clock,
        cooldownSeconds: config.JWKS_REFRESH_COOLDOWN_SECONDS,
        maxAgeSeconds: config.JWKS_MAX_AGE_SECONDS,
        source: idpJwksSource(http),
      }),
      tokens: new TokenService({
        operation: new AuditedOperation(app, new AuditWriter()),
        policy,
        index: new BlindIndex(keys),
        cipher: new FieldCipher(keys),
        mint: new TokenMint(keys),
        clock,
        graceSeconds: config.GRACE_PERIOD_SECONDS,
        keyVersion: config.PSEUDONYM_KEY_VERSION,
      }),
      statuses: new TransactionStatusService({ pool: app, policy, clock }),
      vault: new IdentityVault({
        operation: new AuditedOperation(app, new AuditWriter()),
        index: new BlindIndex(keys),
        cipher: new FieldCipher(keys),
        clock,
        keyVersion: config.PSEUDONYM_KEY_VERSION,
      }),
    });
    return [
      {
        module: PrivacyModule,
        controllers: [PrivacyController],
        providers: [
          { provide: PRIVACY_HTTP, useValue: privacy },
          { provide: OWNED_POOLS, useValue: owned },
          PoolLifecycle,
        ],
      },
    ];
  };
}
