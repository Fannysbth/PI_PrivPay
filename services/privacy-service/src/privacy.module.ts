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
  Patch,
  Post,
  Query,
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
import { AuditLogService, AuditReader, AuditedOperation, AuditWriter } from './audit';
import { loadPrivacyConfig } from './config';
import { BlindIndex, FieldCipher, TokenMint, loadKeys, type PrivacyKeys } from './crypto';
import { DePseudonymizeService, DisclosureService } from './disclosure';
import { IdentityVault } from './identity';
import { PolicyEngine } from './policy';
import { PrivacyHttp } from './privacy-http';
import { RevocationService } from './revocation';
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

  @Post('resolve-domain')
  @HttpCode(200)
  resolveDomain(@Req() req: Request, @Body() body: unknown) {
    return this.privacy.resolveDomain(req.headers, body);
  }

  @Post('pseudonym/:pseudonym/revoke')
  @HttpCode(200)
  revokeToken(@Req() req: Request, @Param('pseudonym') pseudonym: string, @Body() body: unknown) {
    return this.privacy.revokeToken(req.headers, pseudonym, body);
  }

  @Post('subject/revoke')
  @HttpCode(200)
  revokeSubject(@Req() req: Request, @Body() body: unknown) {
    return this.privacy.revokeSubject(req.headers, body);
  }

  @Get('audit-log')
  auditLog(@Req() req: Request, @Query() query: unknown) {
    return this.privacy.auditLog(req.headers, query);
  }

  @Get('audit-log/summary')
  auditSummary(@Req() req: Request, @Query() query: unknown) {
    return this.privacy.auditSummary(req.headers, query);
  }

  @Get('audit-log/timeline/:pseudonym')
  auditTimeline(
    @Req() req: Request,
    @Param('pseudonym') pseudonym: string,
    @Query() query: unknown,
  ) {
    return this.privacy.auditTimeline(req.headers, pseudonym, query);
  }

  @Post('disclosure-requests')
  @HttpCode(201)
  requestDisclosure(@Req() req: Request, @Body() body: unknown) {
    return this.privacy.requestDisclosure(req.headers, body);
  }

  @Post('disclosure-requests/:id/approve')
  @HttpCode(200)
  approveDisclosure(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.approveDisclosure(req.headers, id, body);
  }

  @Post('disclosure-requests/:id/reject')
  @HttpCode(200)
  rejectDisclosure(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.rejectDisclosure(req.headers, id, body);
  }

  @Post('de-pseudonymize')
  @HttpCode(200)
  dePseudonymize(@Req() req: Request, @Body() body: unknown) {
    return this.privacy.dePseudonymize(req.headers, body);
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
  readonly pools?: { readonly app: Pool; readonly auditor?: Pool };
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
    // Reading the audit log goes through its own role, never the app pool (spec privacy 3).
    let auditor = overrides.pools?.auditor;
    if (auditor === undefined) {
      auditor = createPool(config, {
        role: db.auditor ?? 'privpay_auditor',
        database: db.database,
      });
      owned.push(auditor);
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
    // One writer path for every operation of the service (M2-04).
    const operation = new AuditedOperation(app, new AuditWriter());
    const vault = new IdentityVault({
      operation,
      index: new BlindIndex(keys),
      cipher: new FieldCipher(keys),
      clock,
      keyVersion: config.PSEUDONYM_KEY_VERSION,
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
        operation,
        policy,
        index: new BlindIndex(keys),
        cipher: new FieldCipher(keys),
        mint: new TokenMint(keys),
        clock,
        graceSeconds: config.GRACE_PERIOD_SECONDS,
        keyVersion: config.PSEUDONYM_KEY_VERSION,
      }),
      statuses: new TransactionStatusService({ pool: app, policy, clock }),
      vault,
      disclosure: new DisclosureService({
        operation,
        policy,
        clock,
        graceSeconds: config.GRACE_PERIOD_SECONDS,
        approvalTtlSeconds: config.DISCLOSURE_APPROVAL_TTL_SECONDS,
      }),
      opening: new DePseudonymizeService({
        operation,
        policy,
        cipher: new FieldCipher(keys),
        clock,
        graceSeconds: config.GRACE_PERIOD_SECONDS,
      }),
      auditLog: new AuditLogService({
        operation,
        reader: new AuditReader(auditor),
      }),
      revocation: new RevocationService({
        operation,
        index: new BlindIndex(keys),
        vault,
        clock,
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
