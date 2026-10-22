import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema, safeEqual } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { startGateway, type Harness } from '../../../gateway/test/harness';
import { privacyModules } from '../../../privacy-service/src/privacy.module';
import { reconciliationModules } from '../../src/reconciliation.module';
import { FakeTransactions } from '../fakes';

// The stack of a test that wants the Gateway, Privacy and Reconciliation to be the real ones: only the network, the IdP
// and Transaction are doubles. The IdP is the Gateway harness's, so one key signs every token and every service trusts
// it. Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const privacyMigrations = join(__dirname, '..', '..', '..', 'privacy-service', 'migrations');
const reconciliationMigrations = join(__dirname, '..', '..', 'migrations');
const RECONCILIATION_SECRET = 'fake-secret-reconciliation-0123456789abcdef';
const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');

export interface Stack {
  readonly gateway: Harness;
  readonly privacy: ServiceApp;
  readonly reconciliation: ServiceApp;
  readonly privacyDb: TestDb;
  readonly reconciliationDb: TestDb;
  readonly transactions: FakeTransactions;
  /** The lines the real Reconciliation and Privacy wrote to their logs. */
  readonly logs: { readonly privacy: string[]; readonly reconciliation: string[] };
  /** A call from the Gateway's side, as `client`, straight to Privacy (to make the state a case needs). */
  toPrivacy(client: string, path: string, body: object, actor?: 'auditor' | 'admin'): request.Test;
  close(): Promise<void>;
}

/** Sends a `fetch` of a service to an app of this test, over supertest, the way a socket would carry it. */
export async function through(
  app: ServiceApp,
  url: URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const method = (init?.method ?? 'GET').toLowerCase() as 'get' | 'post' | 'patch';
  const agent = request(app.httpServer);
  const answer = await agent[method](`${url.pathname}${url.search}`)
    .set(headers)
    .send(typeof init?.body === 'string' ? (JSON.parse(init.body) as object) : {});
  return new Response(answer.text === '' ? null : answer.text, {
    status: answer.status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function startStack(suffix: string): Promise<Stack> {
  const logs = { privacy: [] as string[], reconciliation: [] as string[] };
  const privacyDb = await createTestDb(pg, { service: 'privacy', suffix: `${suffix}p` });
  await migrate(privacyDb.owner, { root: privacyMigrations, mode: 'proposed' });
  const reconciliationDb = await createTestDb(pg, {
    service: 'reconciliation',
    suffix: `${suffix}r`,
  });
  await migrate(reconciliationDb.owner, { root: reconciliationMigrations, mode: 'proposed' });
  const dir = mkdtempSync(join(tmpdir(), 'privpay-stack-'));
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${hex(byte)}\n`);
  }
  writeFileSync(join(dir, 'reconciliation_client_secret'), `${RECONCILIATION_SECRET}\n`);

  // The two apps are made after the closures that reach them, so they live in one object that is filled later.
  const running: { privacy?: ServiceApp; reconciliation?: ServiceApp } = {};
  const gateway = await startGateway(
    {},
    {
      wrapFetch: (inner) => async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.hostname === 'privacy.test' && running.privacy !== undefined) {
          return through(running.privacy, url, init);
        }
        if (url.hostname === 'reconciliation.test' && running.reconciliation !== undefined) {
          return through(running.reconciliation, url, init);
        }
        return inner(input, init);
      },
    },
  );

  // What Reconciliation sees of the world: the Gateway harness's IdP for the keys, a token for its own client, and the
  // real Privacy for everything else it calls.
  const reconciliationFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname === 'idp.test' && url.pathname === '/token') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        client_id?: string;
        client_secret?: string;
        audience?: string[];
      };
      if (
        body.client_id !== 'reconciliation' ||
        !safeEqual(body.client_secret ?? '', RECONCILIATION_SECRET)
      ) {
        return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({
          access_token: gateway.tokens.service('reconciliation', body.audience ?? []),
          token_type: 'Bearer',
          expires_in: 300,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.hostname === 'privacy.test' && running.privacy !== undefined) {
      return through(running.privacy, url, init);
    }
    if (url.hostname === 'idp.test') return gateway.network.fetch(input, init);
    throw new TypeError('connection refused to ' + url.hostname);
  };

  const privacy = await createServiceApp(
    {
      service: 'privacy-service',
      modules: privacyModules({
        fetch: gateway.network.fetch,
        pools: {
          app: privacyDb.app,
          ...(privacyDb.auditor === undefined ? {} : { auditor: privacyDb.auditor }),
        },
      }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      PG_HOST: pg.PG_HOST,
      PG_PORT: String(pg.PG_PORT),
      PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: 'privpay-dev-idp',
      GRACE_PERIOD_SECONDS: '30',
      TTL_PAYMENT_PROCESSING: '900',
      TTL_FRAUD_DETECTION: '2592000',
      TTL_NOTIFICATION: '900',
      TTL_NOTIFICATION_REGISTRATION: '31536000',
      TTL_DAILY_RECONCILIATION: '86400',
      TTL_INTERNAL_AUDIT: '600',
      DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
      RETENTION_DAYS: '90',
      RETENTION_JOB_RUN_UTC: '01:00',
      PSEUDONYM_KEY_VERSION: '1',
      PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
      BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
      FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
    },
    { clock: gateway.clock, logDestination: { write: (line) => void logs.privacy.push(line) } },
  );

  const transactions = new FakeTransactions();
  const reconciliation = await createServiceApp(
    {
      service: 'reconciliation-service',
      modules: reconciliationModules({
        fetch: reconciliationFetch,
        pools: { app: reconciliationDb.app },
        transactions,
        logDestination: { write: (line) => void logs.reconciliation.push(line) },
      }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      PG_HOST: pg.PG_HOST,
      PG_PORT: String(pg.PG_PORT),
      PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: 'privpay-dev-idp',
      RECON_DAILY_RUN_UTC: '00:10',
      PRIVACY_SERVICE_URL: 'http://privacy.test',
      TRANSACTION_SERVICE_URL: 'http://transaction.test',
      RECONCILIATION_CLIENT_SECRET_FILE: join(dir, 'reconciliation_client_secret'),
    },
    {
      clock: gateway.clock,
      logDestination: { write: (line) => void logs.reconciliation.push(line) },
    },
  );

  running.privacy = privacy;
  running.reconciliation = reconciliation;
  const privacyApp = privacy;
  const reconciliationApp = reconciliation;
  return {
    gateway,
    privacy: privacyApp,
    reconciliation: reconciliationApp,
    privacyDb,
    reconciliationDb,
    transactions,
    logs,
    toPrivacy: (client, path, body, actor) => {
      const call = request(privacyApp.httpServer)
        .post(path)
        .set('authorization', `Bearer ${gateway.tokens.service(client, ['privacy-service'])}`);
      if (actor !== undefined) void call.set('x-actor-token', gateway.tokens.person(actor));
      return call.send(body);
    },
    close: async () => {
      await reconciliationApp.close();
      await privacyApp.close();
      await gateway.close();
      rmSync(dir, { recursive: true, force: true });
      await reconciliationDb.close();
      await privacyDb.close();
    },
  };
}
