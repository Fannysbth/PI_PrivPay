import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { DomainError } from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import { z } from 'zod';
import { join } from 'node:path';
import { loadDevIdpConfig, readServiceSecrets } from './config';
import { fileCustomerCounter } from './customer-counter';
import {
  IdentityProvider,
  type CreatedCustomer,
  type Jwk,
  type TokenResponse,
} from './identity-provider';
import { SEED_FILE, loadSeedUsers, USERNAME } from './seed';

const IDP = Symbol('IDENTITY_PROVIDER');

// Field sizes are capped before anything reads them; unknown fields are refused (conventions: strict input).
const clientId = z.string().min(1).max(64);
const tokenSchema = z.discriminatedUnion('grant_type', [
  z.strictObject({
    grant_type: z.literal('client_credentials'),
    client_id: clientId,
    client_secret: z.string().min(1).max(256),
    audience: z.union([
      z
        .string()
        .min(1)
        .max(64)
        .transform((one) => [one]),
      z.array(z.string().min(1).max(64)).min(1).max(8),
    ]),
  }),
  z.strictObject({
    grant_type: z.literal('dev_login'),
    client_id: clientId,
    username: z.string().regex(USERNAME),
  }),
]);
// Only the username: the IdP needs nothing else to sign a customer in, and holds no NIK, name or e-mail (data
// minimisation; Keycloak will hold the e-mail in the Docker phase, DK-04).
const createUserSchema = z.strictObject({ username: z.string().regex(USERNAME) });

/** A body that does not fit is a validation error; what was wrong with it is not repeated back. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'body');
  return parsed.data;
}

@Controller()
class TokenController {
  constructor(@Inject(IDP) private readonly idp: IdentityProvider) {}

  @Post('token')
  @HttpCode(200)
  token(@Body() body: unknown): TokenResponse {
    return this.idp.token(parse(tokenSchema, body));
  }

  @Get('.well-known/jwks.json')
  jwks(): { keys: Jwk[] } {
    return this.idp.jwks();
  }
}

@Controller('admin/users')
class AdminController {
  constructor(@Inject(IDP) private readonly idp: IdentityProvider) {}

  // The caller is checked before the body, so an unauthenticated request learns nothing about the schema.
  @Post()
  @HttpCode(201)
  create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): CreatedCustomer {
    this.idp.authenticateAdmin(authorization);
    return this.idp.createCustomer(parse(createUserSchema, body).username);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ): void {
    this.idp.authenticateAdmin(authorization);
    this.idp.deleteCustomer(id);
  }
}

@Module({})
class DevIdpModule {}

/**
 * The module factory for `createServiceApp`: validates the dev IdP's own configuration, reads the client secrets and
 * builds the in-memory provider. Any problem is a ConfigError, so the process stops before it listens.
 */
export function devIdpModules({ env, clock }: ModuleContext): ServiceModules {
  const config = loadDevIdpConfig(env);
  const idp = new IdentityProvider({
    clock,
    ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    serviceSecrets: readServiceSecrets(config.DEV_IDP_SECRETS_DIR),
    users: loadSeedUsers(SEED_FILE),
    customerCounter: fileCustomerCounter(join(config.DEV_IDP_STATE_DIR, 'customer-counter')),
  });
  return [
    {
      module: DevIdpModule,
      controllers: [TokenController, AdminController],
      providers: [{ provide: IDP, useValue: idp }],
    },
  ];
}
