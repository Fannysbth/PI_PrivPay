import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { HOSTS, startGateway, type Harness } from '../../../gateway/test/harness';
import { privacyModules } from '../../src/privacy.module';

// TK-01..TK-06, TK-08, TK-09 and TK-13..TK-15 (spec pengujian 4, M3-06), each in two layers. Service layer: the real
// Privacy Service over HTTP, with the detailed reason and exactly one DENIED row in the audit log, counted through the
// auditor role. Gateway layer: the answer Privacy really gave is relayed by the downstream stand-in through the real
// Gateway, and the client must see one of the eight codes and no reason. TK-07 and TK-10 are in their own tickets.
// The Reconciliation of M4-07 does not exist yet, so a stand-in answers on its route with Privacy's wire answer; the
// end-to-end run through Newman is M6-01. Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', '..', 'migrations');
const CUSTOMER = 'CUST-000101';
const ACCOUNT = '1234567801';
const ABSENT = 'PSEU-ABCDEF01';
const A_REQUEST = '11111111-1111-4111-8111-111111111111';
const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');

let db: TestDb;
let privacy: ServiceApp;
let gateway: Harness;
let dir: string;

beforeEach(async () => {
  db = await createTestDb(pg, { service: 'privacy', suffix: 'm306' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  dir = mkdtempSync(join(tmpdir(), 'privpay-security-'));
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${hex(byte)}\n`);
  }
  gateway = await startGateway();
  privacy = await createServiceApp(
    {
      service: 'privacy-service',
      modules: privacyModules({
        fetch: gateway.network.fetch,
        pools: { app: db.app, ...(db.auditor === undefined ? {} : { auditor: db.auditor }) },
      }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      PG_HOST: pg.PG_HOST,
      PG_PORT: String(pg.PG_PORT),
      PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
      IDP_URL: `http://${HOSTS.idp}`,
      IDP_ISSUER: 'privpay-dev-idp',
      GRACE_PERIOD_SECONDS: '30',
      TTL_PAYMENT_PROCESSING: '900',
      TTL_FRAUD_DETECTION: '2592000',
      TTL_NOTIFICATION: '900',
      TTL_NOTIFICATION_REGISTRATION: '31536000',
      TTL_DAILY_RECONCILIATION: '86400',
      TTL_INTERNAL_AUDIT: '600',
      DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
      PSEUDONYM_KEY_VERSION: '1',
      PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
      BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
      FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
    },
    { clock: gateway.clock },
  );
});
afterEach(async () => {
  await privacy.close();
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
  await db.close();
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}
/** A call to Privacy as `client`, with the tokens made fresh now (they live 300 s, and some cases move the clock). */
async function call(
  path: string,
  client: string,
  body: object,
  actor?: 'auditor' | 'admin',
  method: 'post' | 'patch' = 'post',
): Promise<Answer> {
  const sent = request(privacy.httpServer)[method](path);
  void sent.set('authorization', `Bearer ${gateway.tokens.service(client, ['privacy-service'])}`);
  if (actor !== undefined) void sent.set('x-actor-token', gateway.tokens.person(actor));
  const answer = await sent.send(body);
  return { status: answer.status, body: answer.body as Record<string, unknown> };
}
const asAdminConsole = async (path: string, role: 'admin' | 'auditor', body: object) => {
  const answer = await request(privacy.httpServer)
    .post(path)
    .set('authorization', `Bearer ${gateway.tokens.person(role)}`)
    .send(body);
  return { status: answer.status, body: answer.body as Record<string, unknown> };
};

const identity = (over: Record<string, unknown>) => ({
  subject_type: 'CUSTOMER',
  subject_id: CUSTOMER,
  target_service: 'TRANSACTION',
  purpose: 'PAYMENT_PROCESSING',
  transaction_id: 'TX-7001',
  ...over,
});
const pseudonymOf = (answer: Answer): string => {
  expect(answer.status).toBe(200);
  return answer.body['pseudonym'] as string;
};
/** P1 by the Gateway for the customer, as a transaction starts. */
const issueP1 = async (transactionId = 'TX-7001'): Promise<string> =>
  pseudonymOf(
    await call('/pseudonymize', 'api-gateway', identity({ transaction_id: transactionId })),
  );
/** P3, the token of Fraud: Transaction trades its P1 for it (Tabel 2); the Gateway cannot issue it. */
const issueFraud = async (): Promise<string> =>
  pseudonymOf(
    await call('/pseudonymize', 'transaction', {
      source_pseudonym: await issueP1(),
      target_service: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      transaction_id: 'TX-7001',
    }),
  );
/** P7, as Reconciliation gets it for an auditor. */
const issueP7 = async (): Promise<string> => {
  await issueP1();
  return pseudonymOf(
    await call(
      '/pseudonymize',
      'reconciliation',
      {
        subject_type: 'CUSTOMER',
        transaction_id: 'TX-7001',
        target_service: 'RECONCILIATION',
        purpose: 'INTERNAL_AUDIT',
      },
      'auditor',
    ),
  );
};
/** P6, the token of an account: P2 by the Gateway, then P6 as Reconciliation gets it. */
const issueP6 = async (): Promise<string> => {
  await call(
    '/pseudonymize',
    'api-gateway',
    identity({ subject_type: 'ACCOUNT', subject_id: ACCOUNT, transaction_id: 'TX-7005' }),
  );
  return pseudonymOf(
    await call('/pseudonymize', 'reconciliation', {
      subject_type: 'ACCOUNT',
      transaction_id: 'TX-7005',
      target_service: 'RECONCILIATION',
      purpose: 'DAILY_RECONCILIATION',
    }),
  );
};
const deIdentify = (
  client: string,
  token: string,
  purpose: string,
  actor?: 'auditor' | 'admin',
): Promise<Answer> =>
  call('/de-pseudonymize', client, { pseudonym: token, purpose, disclosure_id: A_REQUEST }, actor);

const denied = async (): Promise<Record<string, unknown>[]> =>
  (
    await (db.auditor ?? db.owner).query<Record<string, unknown>>(
      `SELECT action, reason FROM audit_log WHERE status = 'DENIED' ORDER BY created_at, id`,
    )
  ).rows;

/** What the Gateway tells an auditor who asks for a disclosure while downstream relays `relayed` (spec gateway 2). */
async function throughGateway(relayed: Answer) {
  gateway.network.respond(HOSTS['reconciliation-service'], () => ({
    status: relayed.status,
    body: relayed.body,
  }));
  const answer = await request(gateway.app.httpServer)
    .post('/reconciliation/disclosure')
    .set('authorization', `Bearer ${gateway.tokens.person('auditor')}`)
    .send({ audit_token: ABSENT, disclosure_id: A_REQUEST });
  return { status: answer.status, body: answer.body as { error: Record<string, unknown> } };
}

interface Scenario {
  readonly tk: string;
  readonly title: string;
  readonly status: number;
  readonly reason: string;
  /** Sets the state up and returns the refused call. */
  readonly run: () => Promise<Answer>;
  readonly after?: () => Promise<void>;
}
const SCENARIOS: readonly Scenario[] = [
  {
    tk: 'TK-01',
    title: 'Notification uses the token of Fraud',
    status: 403,
    reason: 'SERVICE_MISMATCH',
    run: async () => call('/resolve-domain', 'notification', { notif_token: await issueFraud() }),
  },
  {
    tk: 'TK-02',
    title: 'Reconciliation opens a DAILY_RECONCILIATION token as INTERNAL_AUDIT',
    status: 403,
    reason: 'PURPOSE_MISMATCH',
    run: async () => deIdentify('reconciliation', await issueP6(), 'INTERNAL_AUDIT', 'auditor'),
  },
  {
    tk: 'TK-03',
    title: 'a token after its TTL and grace',
    status: 410,
    reason: 'EXPIRED',
    run: async () => {
      const token = await issueP7();
      gateway.clock.advance(600 + 30 + 1);
      return deIdentify('reconciliation', token, 'INTERNAL_AUDIT', 'auditor');
    },
  },
  {
    tk: 'TK-04',
    title: 'a revoked token',
    status: 403,
    reason: 'REVOKED',
    run: async () => {
      const token = await issueP7();
      expect((await asAdminConsole(`/pseudonym/${token}/revoke`, 'admin', {})).status).toBe(200);
      return deIdentify('reconciliation', token, 'INTERNAL_AUDIT', 'auditor');
    },
  },
  {
    tk: 'TK-05',
    title: 'a random token',
    status: 404,
    reason: 'TOKEN_NOT_FOUND',
    run: () => deIdentify('reconciliation', ABSENT, 'INTERNAL_AUDIT', 'auditor'),
  },
  {
    tk: 'TK-06',
    title: 'a purpose outside the whitelist, and no mapping row',
    status: 403,
    reason: 'POLICY_NOT_ALLOWED',
    run: () => call('/pseudonymize', 'api-gateway', identity({ purpose: 'MARKETING' })),
    after: async () => {
      const rows = await db.owner.query('SELECT 1 FROM pseudonym_mapping');
      expect(rows.rowCount).toBe(0);
    },
  },
  {
    tk: 'TK-08',
    title: 'de-pseudonymization without the role auditor',
    status: 403,
    reason: 'FORBIDDEN_ROLE',
    run: async () => deIdentify('reconciliation', await issueP7(), 'INTERNAL_AUDIT', 'admin'),
  },
  {
    tk: 'TK-09',
    title: 're-issue on a COMPLETED transaction',
    status: 409,
    reason: 'TX_TERMINAL',
    run: async () => {
      const token = await issueP1();
      const done = await call(
        '/transaction-status',
        'transaction',
        { transaction_id: 'TX-7001', status: 'COMPLETED' },
        undefined,
        'patch',
      );
      expect(done.status).toBe(200);
      return call('/re-issue', 'transaction', { pseudonym: token, transaction_id: 'TX-7001' });
    },
  },
  {
    tk: 'TK-13',
    title: 'Fraud exchanges its token to Notification',
    status: 403,
    reason: 'POLICY_NOT_ALLOWED',
    run: async () =>
      call('/pseudonymize', 'fraud', {
        source_pseudonym: await issueFraud(),
        target_service: 'NOTIFICATION',
        purpose: 'NOTIFICATION',
        transaction_id: 'TX-7002',
      }),
  },
  {
    tk: 'TK-14',
    title: 'Fraud asks for an ACCOUNT token',
    status: 403,
    reason: 'POLICY_NOT_ALLOWED',
    run: () =>
      call(
        '/pseudonymize',
        'fraud',
        identity({ subject_type: 'ACCOUNT', subject_id: ACCOUNT, target_service: 'FRAUD' }),
      ),
  },
  {
    tk: 'TK-15',
    title: 'Fraud opens its own token',
    status: 403,
    reason: 'POLICY_NOT_ALLOWED',
    run: async () => deIdentify('fraud', await issueFraud(), 'FRAUD_DETECTION'),
  },
];

describe.each(SCENARIOS)('M3-06 $tk $title', (scenario) => {
  it(`M3-06 ${scenario.tk} service layer: ${String(scenario.status)} ${scenario.reason} and exactly one DENIED row`, async () => {
    const before = (await denied()).length;
    const answer = await scenario.run();
    expect(answer.status).toBe(scenario.status);
    expect(answer.body).toMatchObject({ error: { reason: scenario.reason } });
    const rows = await denied();
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]).toMatchObject({ reason: scenario.reason });
    await scenario.after?.();
  });

  it(`M3-06 ${scenario.tk} gateway layer: the client sees ACCESS_DENIED 403 and no reason (NFR-10, ADR-0008)`, async () => {
    const seen = await throughGateway(await scenario.run());
    expect(seen.status).toBe(403);
    expect(seen.body.error).toEqual({
      code: 'ACCESS_DENIED',
      message: expect.any(String) as unknown,
      request_id: expect.any(String) as unknown,
    });
    expect(JSON.stringify(seen.body)).not.toContain(scenario.reason);
  });
});

describe('M3-06 NFR-10 a token that exists and one that does not look the same to the client', () => {
  it('M3-06 TK-01 TK-05 the whole answer is identical except request_id', async () => {
    const exists = await throughGateway(
      await call('/resolve-domain', 'notification', { notif_token: await issueFraud() }),
    );
    const absent = await throughGateway(
      await call('/resolve-domain', 'notification', { notif_token: ABSENT }),
    );
    const bare = ({ status, body }: typeof exists) => ({
      status,
      error: { ...body.error, request_id: undefined },
    });
    expect(exists.status).toBe(403);
    expect(bare(exists)).toEqual(bare(absent));
  });
});
