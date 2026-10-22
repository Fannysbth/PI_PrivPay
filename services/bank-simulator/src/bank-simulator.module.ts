import 'reflect-metadata';
import { Body, Controller, HttpCode, Inject, Module, Post, type Type } from '@nestjs/common';
import {
  createHttpClient,
  createTokenCache,
  DomainError,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import type { ModuleContext, ServiceModules } from '@privpay/common/nest';
import { z } from 'zod';
import { loadBankSimulatorConfig } from './config';

/** The client the bank user signs in at (tools/dev-idp registry): its token has the role `bank` (AZ-09 at the Gateway). */
const CLIENT_ID = 'bank-simulator';

/**
 * The fictitious accounts and amounts of PRD 16 (TX-10001 and TX-10003; TX-10002 is held and never settled). They are
 * the bank's own data, so they are the only place an account number exists in this process, and they go to the Gateway
 * and nowhere else.
 */
const SEED = [
  { account_number: '1234567801', amount: 35_000 },
  { account_number: '1234567803', amount: 1_500_000 },
] as const;

const INJECTIONS = ['EMPTY_ACCOUNT', 'NEGATIVE_AMOUNT', 'UNPAIRED'] as const;
type Injection = (typeof INJECTIONS)[number];

const isRealDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};
const simulateBody = z.strictObject({
  batch_date: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
    .refine(isRealDate),
  inject: z.array(z.enum(INJECTIONS)).max(INJECTIONS.length).optional(),
});

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().min(1).max(300),
});

interface ReportItem {
  account_number: string;
  amount: number;
  bank_reference: string;
}

/** TF-13 and TF-16: the report of the day, with the faults a test asks for (spec reconciliation 4). */
export function buildReport(batchDate: string, inject: readonly Injection[] = []): ReportItem[] {
  const stamp = batchDate.replaceAll('-', '');
  const reference = (n: number): string => `BNK-${stamp}-${String(n).padStart(4, '0')}`;
  const items: ReportItem[] = SEED.map((line, index) => ({
    ...line,
    bank_reference: reference(index + 1),
  }));
  if (inject.includes('EMPTY_ACCOUNT')) {
    items.push({ account_number: '', amount: 10_000, bank_reference: reference(items.length + 1) });
  }
  if (inject.includes('NEGATIVE_AMOUNT')) {
    items.push({
      account_number: SEED[0].account_number,
      amount: -1,
      bank_reference: reference(items.length + 1),
    });
  }
  if (inject.includes('UNPAIRED')) {
    // A valid line the bank has and the platform does not: an account no transaction of the day used.
    items.push({ account_number: '1234567899', amount: 777_000, bank_reference: reference(3) });
  }
  return items;
}

const SIMULATOR = Symbol('SIMULATOR');

class Simulator {
  constructor(
    private readonly deps: {
      readonly http: HttpClient;
      readonly bankToken: Pick<TokenCache, 'get'>;
    },
  ) {}

  async settle(body: unknown) {
    const parsed = simulateBody.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR');
    const items = buildReport(parsed.data.batch_date, parsed.data.inject);
    const answer = await this.deps.http.request({
      service: 'gateway',
      method: 'POST',
      path: '/settlement/report',
      body: { batch_date: parsed.data.batch_date, items },
      // The bank sends a report once; whether a second one is safe is for Reconciliation to say (K-22), not the bank.
      idempotent: false,
      authorization: `Bearer ${await this.deps.bankToken.get()}`,
    });
    return { sent_items: items.length, gateway_status: answer.status, gateway_body: answer.body };
  }
}

@Controller()
class SimulateController {
  constructor(@Inject(SIMULATOR) private readonly simulator: Simulator) {}

  @Post('simulate/settlement')
  @HttpCode(200)
  settle(@Body() body: unknown) {
    return this.simulator.settle(body);
  }
}

@Module({})
class BankSimulatorModule {}

/**
 * The module factory of the bank simulator. Configuration problems are raised here, so the process stops before it
 * listens. Without `BANK_SIMULATOR_TEST_ENDPOINTS=true` no route is registered at all.
 */
export function bankSimulatorModules(
  overrides: { readonly fetch?: typeof fetch } = {},
): (context: ModuleContext) => ServiceModules {
  return ({ env, clock }) => {
    const config = loadBankSimulatorConfig(env);
    const http: HttpClient = createHttpClient({
      baseUrls: { idp: config.IDP_URL, gateway: config.GATEWAY_URL },
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxRetries: config.HTTP_MAX_RETRY,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    const bankToken = createTokenCache({
      clock,
      fetchToken: async () => {
        const answer = await http.request({
          service: 'idp',
          method: 'POST',
          path: '/token',
          body: { grant_type: 'dev_login', client_id: CLIENT_ID, username: config.BANK_USERNAME },
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
    const controllers: Type[] = config.BANK_SIMULATOR_TEST_ENDPOINTS ? [SimulateController] : [];
    return [
      {
        module: BankSimulatorModule,
        controllers,
        providers: [{ provide: SIMULATOR, useValue: new Simulator({ http, bankToken }) }],
      },
    ];
  };
}
