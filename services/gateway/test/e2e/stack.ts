import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock,
  loadConfig,
  migrate,
  pgConfigSchema,
  type PrivacyMode,
  type Timers,
} from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { devIdpModules } from '../../../../tools/dev-idp/src/http';
import { SERVICE_CLIENTS } from '../../../../tools/dev-idp/src/registry';
import { fraudModules } from '../../../fraud-service/src/fraud.module';
import { gatewayModules } from '../../src/gateway.module';
import { notificationModules } from '../../../notification-service/src/notification.module';
import { privacyModules } from '../../../privacy-service/src/privacy.module';
import { reconciliationModules } from '../../../reconciliation-service/src/reconciliation.module';
import { smsSimulatorModules } from '../../../sms-simulator/src/sms-simulator.module';
import { transactionModules } from '../../../transaction-service/src/transaction.module';

// The whole system of the local phase in one process, for the end-to-end tests of M4-08 and M4-09: the real dev IdP, the
// real Gateway, Privacy, Transaction, Fraud, Notification, the SMS simulator and Reconciliation, each on its own database
// and talking to the others only over (in-process) HTTP, with their own service tokens from the IdP. What is not real is
// the network (a hostname is mapped to an app, and can be taken down), the clock (one FakeClock for all) and the bank.
// Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const ISSUER = 'privpay-dev-idp';
const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');
const migrations = (service: string): string =>
  join(__dirname, '..', '..', '..', service, 'migrations');

export type Host =
  | 'idp.test'
  | 'privacy.test'
  | 'transaction.test'
  | 'fraud.test'
  | 'notification.test'
  | 'sms.test'
  | 'reconciliation.test';

export interface Stack {
  readonly clock: FakeClock;
  readonly gateway: ServiceApp;
  readonly apps: Readonly<Record<Host | 'gateway', ServiceApp>>;
  readonly dbs: {
    readonly privacy: TestDb;
    readonly transaction: TestDb;
    readonly fraud: TestDb;
    readonly notification: TestDb;
    readonly reconciliation: TestDb;
  };
  /** Every line each service logged. */
  readonly logs: Record<Host | 'gateway', string[]>;
  /** Hosts that refuse connections, as a service that is down. */
  readonly down: Set<Host>;
  /**
   * Makes the calls to `host` at `path` answer 503, `times` of them (all, by default): one step of a flow failing while the
   * rest of the host works. `clear()` of the stack undoes it.
   */
  fail(host: Host, path: string, times?: number): void;
  /** Every call that reached a host, in order, as `METHOD host path`. */
  readonly calls: string[];
  /** Every call that was tried, also at a host that is down or not there (baseline has no Privacy), as `METHOD host path`. */
  readonly attempted: string[];
  /**
   * The bodies that went to each host, in memory only (the observer of docs/spec/pengujian-dan-pengukuran.md 6, target 1):
   * a test scans them and reports attribute and place, never a value.
   */
  readonly payloads: Record<string, string[]>;
  /**
   * The answers each host gave, in memory only (G5): what a caller RECEIVES, e.g. what Reconciliation reads from
   * Transaction. Scanned the same way as `payloads`.
   */
  readonly responses: Record<string, string[]>;
  /** Runs before a call reaches its host; a test uses it to move the clock at an exact point of a flow. */
  hook: ((host: Host, method: string, path: string) => void) | undefined;
  /** A token of a seeded person or customer, as the dev IdP gives it (`dev_login`). */
  login(
    client: 'customer-app' | 'admin-console' | 'bank-simulator',
    username: string,
  ): Promise<string>;
  /** Empties the databases and the simulator, between tests of one file; the IdP keeps its users. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** The stack of baseline mode (M5-02): the same system without Privacy Service, its database and its address. */
export type BaselineStack = Omit<Stack, 'dbs' | 'apps'> & {
  readonly apps: Readonly<Record<Exclude<Host, 'privacy.test'> | 'gateway', ServiceApp>>;
  readonly dbs: Omit<Stack['dbs'], 'privacy'>;
};

export interface StackOptions {
  /** The mode of every service of the stack; proposed unless said otherwise. */
  readonly mode?: PrivacyMode;
  /** TTL of a payment token and the grace after it, in seconds. Shorter than the 300 s of a JWT, a token can end mid-flow. */
  readonly paymentTtl?: string;
  readonly grace?: string;
  /**
   * Turns the jobs of a service on, with a timer of the test's own (M4-10). A service that is not named has its jobs off,
   * as in every other test.
   */
  readonly timers?: {
    readonly privacy?: Timers;
    readonly transaction?: Timers;
    readonly reconciliation?: Timers;
  };
}

export function startStack(
  suffix: string,
  options: StackOptions & { readonly mode: 'baseline' },
): Promise<BaselineStack>;
export function startStack(suffix: string, options?: StackOptions): Promise<Stack>;
export async function startStack(
  suffix: string,
  options: StackOptions = {},
): Promise<Stack | BaselineStack> {
  const mode = options.mode ?? 'proposed';
  // ADR-0006: the Privacy address belongs to proposed only; a baseline service refuses to start with it.
  const privacyUrl = mode === 'proposed' ? { PRIVACY_SERVICE_URL: 'http://privacy.test' } : {};
  const clock = new FakeClock('2026-10-05T12:05:00.000Z');
  const logs = {} as Record<Host | 'gateway', string[]>;
  const sink = (name: Host | 'gateway') => {
    if (!Object.hasOwn(logs, name)) logs[name] = [];
    return { write: (line: string) => void logs[name].push(line) };
  };
  const down = new Set<Host>();
  const failing = new Map<string, number>();
  const calls: string[] = [];
  const attempted: string[] = [];
  const payloads: Record<string, string[]> = {};
  const responses: Record<string, string[]> = {};

  const dir = mkdtempSync(join(tmpdir(), 'privpay-e2e-'));
  const secretsDir = join(dir, 'secrets');
  mkdirSync(secretsDir);
  for (const client of SERVICE_CLIENTS) {
    writeFileSync(
      join(secretsDir, `${client}_client_secret`),
      `${randomBytes(32).toString('base64url')}\n`,
    );
  }
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${hex(byte)}\n`);
  }
  const secret = (client: string): string => join(secretsDir, `${client}_client_secret`);

  const dbs = {
    privacy:
      mode === 'proposed'
        ? await createTestDb(pg, { service: 'privacy', suffix: `${suffix}p` })
        : undefined,
    transaction: await createTestDb(pg, { service: 'transaction', suffix: `${suffix}t` }),
    fraud: await createTestDb(pg, { service: 'fraud', suffix: `${suffix}f` }),
    notification: await createTestDb(pg, { service: 'notification', suffix: `${suffix}n` }),
    reconciliation: await createTestDb(pg, { service: 'reconciliation', suffix: `${suffix}r` }),
  };
  if (dbs.privacy !== undefined) {
    await migrate(dbs.privacy.owner, { root: migrations('privacy-service'), mode: 'proposed' });
  }
  await migrate(dbs.transaction.owner, { root: migrations('transaction-service'), mode });
  await migrate(dbs.fraud.owner, { root: migrations('fraud-service'), mode });
  await migrate(dbs.notification.owner, { root: migrations('notification-service'), mode });
  await migrate(dbs.reconciliation.owner, { root: migrations('reconciliation-service'), mode });

  const running: Partial<Record<Host, ServiceApp>> = {};
  const stack = { hook: undefined } as { hook: Stack['hook'] };

  /** The network as the services see it: a hostname is an app of this test, unless it is down. */
  const network: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const host = url.hostname as Host;
    const method = (init?.method ?? 'GET').toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
    stack.hook?.(host, method, url.pathname);
    attempted.push(`${method.toUpperCase()} ${host} ${url.pathname}`);
    if (typeof init?.body === 'string') (payloads[host] ??= []).push(init.body);
    const target = running[host];
    if (target === undefined || down.has(host)) {
      throw new TypeError('connection refused to ' + url.hostname);
    }
    calls.push(`${method.toUpperCase()} ${host} ${url.pathname}`);
    const key = `${host} ${url.pathname}`;
    const left = failing.get(key);
    if (left !== undefined && left > 0) {
      failing.set(key, left - 1);
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const agent = request(target.httpServer);
    const call = agent[method](`${url.pathname}${url.search}`).set(headers);
    const answer = await (typeof init?.body === 'string'
      ? call.send(JSON.parse(init.body) as object)
      : call);
    if (answer.text !== '') (responses[host] ??= []).push(answer.text);
    return new Response(answer.status === 204 || answer.text === '' ? null : answer.text, {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  const base = { PRIVACY_MODE: mode, PORT: '0' };
  const pgEnv = {
    PG_HOST: pg.PG_HOST,
    PG_PORT: String(pg.PG_PORT),
    PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
  };
  const idpEnv = { IDP_URL: 'http://idp.test', IDP_ISSUER: ISSUER };
  const appOptions = (name: Host | 'gateway') => ({ clock, logDestination: sink(name) });

  running['idp.test'] = await createServiceApp(
    { service: 'dev-idp', modules: devIdpModules },
    {
      ...base,
      DEV_IDP_ENABLED: 'true',
      NODE_ENV: 'test',
      DEV_IDP_SECRETS_DIR: secretsDir,
      DEV_IDP_STATE_DIR: join(dir, 'state'),
    },
    appOptions('idp.test'),
  );
  running['sms.test'] = await createServiceApp(
    { service: 'sms-simulator', modules: smsSimulatorModules({ fetch: network }) },
    { ...base, ...idpEnv, SMS_SIMULATOR_TEST_ENDPOINTS: 'true' },
    appOptions('sms.test'),
  );
  if (dbs.privacy !== undefined) {
    const privacyDb = dbs.privacy;
    running['privacy.test'] = await createServiceApp(
      {
        service: 'privacy-service',
        modules: privacyModules({
          fetch: network,
          logDestination: sink('privacy.test'),
          timers: options.timers?.privacy,
          pools: {
            app: privacyDb.app,
            ...(privacyDb.auditor === undefined ? {} : { auditor: privacyDb.auditor }),
          },
        }),
      },
      {
        ...base,
        ...pgEnv,
        ...idpEnv,
        GRACE_PERIOD_SECONDS: options.grace ?? '30',
        TTL_PAYMENT_PROCESSING: options.paymentTtl ?? '900',
        TTL_FRAUD_DETECTION: '2592000',
        TTL_NOTIFICATION: '900',
        TTL_NOTIFICATION_REGISTRATION: '31536000',
        TTL_DAILY_RECONCILIATION: '86400',
        TTL_INTERNAL_AUDIT: '600',
        DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
        RETENTION_DAYS: '90',
        RETENTION_JOB_RUN_UTC: '01:00',
        ...(options.timers?.privacy === undefined ? {} : { SCHEDULER_ENABLED: 'true' }),
        PSEUDONYM_KEY_VERSION: '1',
        PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
        BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
        FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
      },
      appOptions('privacy.test'),
    );
  }
  running['fraud.test'] = await createServiceApp(
    {
      service: 'fraud-service',
      modules: fraudModules({ fetch: network, pools: { app: dbs.fraud.app } }),
    },
    {
      ...base,
      ...pgEnv,
      ...idpEnv,
      FRAUD_AMOUNT_THRESHOLD: '1000000',
      FRAUD_ODD_HOUR_START: '22',
      FRAUD_ODD_HOUR_END: '6',
      FRAUD_HOLD_THRESHOLD: '50',
      FRAUD_BLOCK_THRESHOLD: '90',

      FRAUD_HISTORY_DAYS: '30',
    },
    appOptions('fraud.test'),
  );
  running['notification.test'] = await createServiceApp(
    {
      service: 'notification-service',
      modules: notificationModules({ fetch: network, pools: { app: dbs.notification.app } }),
    },
    {
      ...base,
      ...pgEnv,
      ...idpEnv,
      ...privacyUrl,
      SMS_SIMULATOR_URL: 'http://sms.test',
      NOTIFICATION_CLIENT_SECRET_FILE: secret('notification'),
    },
    appOptions('notification.test'),
  );
  running['transaction.test'] = await createServiceApp(
    {
      service: 'transaction-service',
      modules: transactionModules({
        fetch: network,
        logDestination: sink('transaction.test'),
        pools: { app: dbs.transaction.app },
        timers: options.timers?.transaction,
      }),
    },
    {
      ...base,
      ...pgEnv,
      ...idpEnv,
      FRAUD_AMOUNT_THRESHOLD: '1000000',
      TX_PENDING_TIMEOUT_SECONDS: '300',
      TX_SWEEP_INTERVAL_SECONDS: '30',
      ...(options.timers?.transaction === undefined ? {} : { SCHEDULER_ENABLED: 'true' }),
      ...privacyUrl,
      FRAUD_SERVICE_URL: 'http://fraud.test',
      NOTIFICATION_SERVICE_URL: 'http://notification.test',
      TRANSACTION_CLIENT_SECRET_FILE: secret('transaction'),
    },
    appOptions('transaction.test'),
  );
  running['reconciliation.test'] = await createServiceApp(
    {
      service: 'reconciliation-service',
      modules: reconciliationModules({
        fetch: network,
        logDestination: sink('reconciliation.test'),
        pools: { app: dbs.reconciliation.app },
        timers: options.timers?.reconciliation,
      }),
    },
    {
      ...base,
      ...pgEnv,
      ...idpEnv,
      RECON_DAILY_RUN_UTC: '00:10',
      ...(options.timers?.reconciliation === undefined ? {} : { SCHEDULER_ENABLED: 'true' }),
      ...privacyUrl,
      TRANSACTION_SERVICE_URL: 'http://transaction.test',
      RECONCILIATION_CLIENT_SECRET_FILE: secret('reconciliation'),
    },
    appOptions('reconciliation.test'),
  );
  const gateway = await createServiceApp(
    {
      service: 'gateway',
      modules: gatewayModules({ fetch: network, logDestination: sink('gateway') }),
    },
    {
      ...base,
      ...idpEnv,
      ...privacyUrl,
      TRANSACTION_SERVICE_URL: 'http://transaction.test',
      RECONCILIATION_SERVICE_URL: 'http://reconciliation.test',
      NOTIFICATION_SERVICE_URL: 'http://notification.test',
      API_GATEWAY_CLIENT_SECRET_FILE: secret('api-gateway'),
      RATE_LIMIT_ENABLED: 'false',
    },
    appOptions('gateway'),
  );

  const apps = { ...running, gateway } as Record<Host | 'gateway', ServiceApp>;
  // The privacy members are absent in baseline; the overloads above tell the caller which stack it holds.
  const result: Stack = {
    clock,
    gateway,
    apps,
    // Baseline has no `privacy` key at all, as its type says.
    dbs: Object.fromEntries(
      Object.entries(dbs).filter(([, db]) => db !== undefined),
    ) as unknown as Stack['dbs'],
    logs,
    down,
    calls,
    attempted,
    payloads,
    responses,
    fail: (host, path, times = Number.MAX_SAFE_INTEGER) =>
      void failing.set(`${host} ${path}`, times),
    get hook() {
      return stack.hook;
    },
    set hook(value) {
      stack.hook = value;
    },
    login: async (client, username) => {
      const answer = await request(apps['idp.test'].httpServer)
        .post('/token')
        .send({ grant_type: 'dev_login', client_id: client, username });
      return (answer.body as { access_token: string }).access_token;
    },
    reset: async () => {
      // The databases are emptied by their owners (the application roles may not truncate); the IdP keeps its users.
      await dbs.privacy?.owner.query(
        'TRUNCATE pseudonym_mapping, transaction_status, audit_log, identity_vault, disclosure_request CASCADE',
      );
      await dbs.transaction.owner.query('TRUNCATE transactions');
      await dbs.fraud.owner.query('TRUNCATE fraud_assessments');
      await dbs.notification.owner.query('TRUNCATE contact_registry, notification_log');
      await dbs.reconciliation.owner.query(
        'TRUNCATE settlement_items, settlement_batches, audit_requests',
      );
      await request(apps['sms.test'].httpServer).delete('/__test/messages');
      down.clear();
      failing.clear();
      calls.length = 0;
      attempted.length = 0;
      for (const bodies of Object.values(payloads)) bodies.length = 0;
      for (const bodies of Object.values(responses)) bodies.length = 0;
      stack.hook = undefined;
      for (const name of Object.keys(logs) as (Host | 'gateway')[]) logs[name].length = 0;
    },
    close: async () => {
      for (const app of [gateway, ...Object.values(running)].reverse()) await app.close();
      rmSync(dir, { recursive: true, force: true });
      for (const db of Object.values(dbs)) await db?.close();
    },
  };
  return result;
}
