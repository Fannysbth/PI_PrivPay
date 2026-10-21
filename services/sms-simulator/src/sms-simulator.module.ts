import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  type Type,
} from '@nestjs/common';
import {
  authenticate,
  createHttpClient,
  DomainError,
  idpJwksSource,
  JwksKeys,
  parseBearer,
  unverifiedKid,
  type AuthHeaders,
  type Authenticated,
  type HttpClient,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import type { Request } from 'express';
import { z } from 'zod';
import { loadSmsSimulatorConfig } from './config';

const SERVICE = 'sms-simulator';
/** Spec notification 4, AZ-41: only Notification sends a message. */
const CALLER = 'NOTIFICATION';

const SMS = z.strictObject({
  to: z.string().regex(/^08[0-9]{8,12}$/),
  text: z.string().min(1).max(320),
});

interface Message {
  readonly to: string;
  readonly text: string;
}

/** The messages live in this object and nowhere else: not in a file, a log or a metric (D-08). */
class MessageStore {
  private readonly messages: Message[] = [];
  add(message: Message): void {
    this.messages.push(message);
  }
  all(): Message[] {
    return this.messages.map((message) => ({ ...message }));
  }
  clear(): void {
    this.messages.length = 0;
  }
}

const STORE = Symbol('STORE');
const RECEIVER = Symbol('RECEIVER');

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/** Proves the caller, checks the shape, keeps the message. `requesting_service` is the token's, never the body's. */
class Receiver {
  constructor(
    private readonly deps: {
      readonly clock: ModuleContext['clock'];
      readonly issuer: string;
      readonly keys: JwksKeys;
      readonly store: MessageStore;
      readonly failing: boolean;
    },
  ) {}

  private async caller(headers: AuthHeaders): Promise<Authenticated> {
    const bearer = parseBearer(single(headers['authorization']));
    const actor = single(headers['x-actor-token']);
    if (bearer !== undefined) await this.deps.keys.ensure(unverifiedKid(bearer));
    if (actor !== undefined) await this.deps.keys.ensure(unverifiedKid(actor));
    return authenticate(headers, {
      clock: this.deps.clock,
      issuer: this.deps.issuer,
      service: SERVICE,
      resolveKey: (kid) => this.deps.keys.resolveKey(kid),
    });
  }

  async receive(headers: AuthHeaders, body: unknown): Promise<{ accepted: true }> {
    const who = await this.caller(headers);
    if (who.requestingService !== CALLER) throw new DomainError('POLICY_NOT_ALLOWED');
    const parsed = SMS.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    // FR-20: a failure that a test asks for; nothing is kept for a message that was not accepted.
    if (this.deps.failing) throw new DomainError('SERVICE_UNAVAILABLE', 'injected');
    this.deps.store.add(parsed.data);
    return { accepted: true };
  }
}

@Controller()
class SmsController {
  constructor(@Inject(RECEIVER) private readonly receiver: Receiver) {}

  @Post('sms')
  @HttpCode(202)
  receive(@Req() req: Request, @Body() body: unknown) {
    return this.receiver.receive(req.headers, body);
  }
}

/** Registered only when SMS_SIMULATOR_TEST_ENDPOINTS=true: otherwise the routes do not exist (404, AZ-42). */
@Controller()
class TestMessagesController {
  constructor(@Inject(STORE) private readonly store: MessageStore) {}

  @Get('__test/messages')
  list() {
    return { messages: this.store.all() };
  }

  @Delete('__test/messages')
  @HttpCode(204)
  clear(): void {
    this.store.clear();
  }
}

@Module({})
class SmsSimulatorModule {}

/**
 * The module factory of the SMS simulator. Configuration problems are raised here, so the process stops before it
 * listens.
 */
export function smsSimulatorModules(
  overrides: { readonly fetch?: typeof fetch } = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadSmsSimulatorConfig(env);
    const http: HttpClient = createHttpClient({
      baseUrls: { idp: config.IDP_URL },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    const store = new MessageStore();
    const receiver = new Receiver({
      clock,
      issuer: config.IDP_ISSUER,
      keys: new JwksKeys({
        clock,
        cooldownSeconds: config.JWKS_REFRESH_COOLDOWN_SECONDS,
        maxAgeSeconds: config.JWKS_MAX_AGE_SECONDS,
        source: idpJwksSource(http),
      }),
      store,
      failing: config.SMS_SIMULATOR_FAIL,
    });
    const controllers: Type[] = [SmsController];
    if (config.SMS_SIMULATOR_TEST_ENDPOINTS) controllers.push(TestMessagesController);
    return [
      {
        module: SmsSimulatorModule,
        controllers,
        providers: [
          { provide: STORE, useValue: store },
          { provide: RECEIVER, useValue: receiver },
        ],
      },
    ];
  };
}
