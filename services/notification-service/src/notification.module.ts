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
  BoundedTtlCache,
  createHttpClient,
  createServicePool,
  createIdpTokenCache,
  idpJwksSource,
  idpOf,
  JwksKeys,
  privacyBaseUrl,
  subjectRefShape,
  tokenCacheSettings,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { baselineContactRepository, baselinePrivacyClient } from './baseline';
import { proposedContactRepository } from './proposed';
import { loadNotificationConfig } from './config';
import {
  CachedPrivacyClient,
  HttpPrivacyClient,
  HttpSmsGateway,
  NotificationService,
  type PrivacyClient,
  type SmsGateway,
} from './notification';
import { NotificationHttp } from './notification-http';

/** The service account of Notification at the IdP (tools/dev-idp registry): it may ask for tokens for these two. */
const CLIENT_ID = 'notification';

const NOTIFICATION_HTTP = Symbol('NOTIFICATION_HTTP');
const OWNED_POOLS = Symbol('OWNED_POOLS');

@Controller()
class NotificationController {
  constructor(@Inject(NOTIFICATION_HTTP) private readonly notifications: NotificationHttp) {}

  // 201 for the first registration of a domain token, 200 for a repeat (spec notification 3.1).
  @Post('notification/register')
  async register(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.notifications.register(req.headers, body);
    res.status(result.created ? 201 : 200);
    return result.body;
  }

  @Post('notification/send')
  @HttpCode(200)
  send(@Req() req: Request, @Body() body: unknown) {
    return this.notifications.send(req.headers, body);
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
class NotificationModule {}

export interface NotificationOverrides {
  readonly fetch?: typeof fetch;
  readonly pools?: { readonly app: Pool };
  /** Replace the adapters, for a test that does not want the network. */
  readonly privacy?: PrivacyClient;
  readonly sms?: SmsGateway;
}

/**
 * The module factory of the notification service. Configuration and secret problems are raised here, so the process
 * stops before it listens.
 */
export function notificationModules(
  overrides: NotificationOverrides = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadNotificationConfig(env);
    const owned: Pool[] = [];
    let app = overrides.pools?.app;
    if (app === undefined) {
      app = createServicePool(config, 'notification');
      owned.push(app);
    }
    const http: HttpClient = createHttpClient({
      baseUrls: {
        idp: config.IDP_URL,
        ...privacyBaseUrl(config.PRIVACY_SERVICE_URL),
        'sms-simulator': config.SMS_SIMULATOR_URL,
      },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    // One cached service token per service it calls (NFR-21); the secret never leaves this closure.
    const tokenFor = (audience: string): TokenCache =>
      createIdpTokenCache({
        http,
        clock,
        idp: idpOf(config),
        grant: {
          type: 'client-credentials',
          clientId: CLIENT_ID,
          clientSecret: config.clientSecret,
          audience,
        },
      });

    const notifications = new NotificationHttp({
      clock,
      issuer: config.IDP_ISSUER,
      keys: new JwksKeys({
        clock,
        cooldownSeconds: config.JWKS_REFRESH_COOLDOWN_SECONDS,
        maxAgeSeconds: config.JWKS_MAX_AGE_SECONDS,
        source: idpJwksSource(http, idpOf(config)),
      }),
      customerRef: subjectRefShape(config.PRIVACY_MODE).customer,
      acceptClientIdentity: config.PRIVACY_MODE === 'baseline',
      notifications: new NotificationService({
        // ADR-0006: the one place the mode picks the adapters; the service below is the same code in both.
        contacts:
          config.PRIVACY_MODE === 'baseline'
            ? baselineContactRepository(config.PRIVACY_MODE, app)
            : proposedContactRepository(app),
        privacy:
          overrides.privacy ??
          (config.PRIVACY_MODE === 'baseline'
            ? baselinePrivacyClient(config.PRIVACY_MODE)
            : // ADR-0020: the domain token is kept for T seconds at most (T = 0 keeps nothing).
              new CachedPrivacyClient(
                new HttpPrivacyClient({ http, serviceToken: tokenFor('privacy-service') }),
                new BoundedTtlCache<string>({ clock, ...tokenCacheSettings(config) }),
              )),
        sms: overrides.sms ?? new HttpSmsGateway({ http, serviceToken: tokenFor('sms-simulator') }),
        clock,
      }),
    });
    return [
      {
        module: NotificationModule,
        controllers: [NotificationController],
        providers: [
          { provide: NOTIFICATION_HTTP, useValue: notifications },
          { provide: OWNED_POOLS, useValue: owned },
          PoolLifecycle,
        ],
      },
    ];
  };
}
