import { type ServiceApp } from '@privpay/common/nest';
import { type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { HOSTS, type Harness } from '../../../gateway/test/harness';
import { startStack, type Stack } from '../../../reconciliation-service/test/support/stack';

// TK-01..TK-06, TK-08, TK-09 and TK-13..TK-15 (spec pengujian 4, M3-06), each in two layers. Service layer: the real
// Privacy Service over HTTP, with the detailed reason and exactly one DENIED row in the audit log, counted through the
// auditor role. Gateway layer, in two kinds (M4-07). Where the refused caller is Reconciliation (TK-02..TK-05, TK-08)
// the refusal travels the whole real path: a client of the real Gateway asks the real Reconciliation to open the token,
// which asks the real Privacy, and the client must see one of the eight codes and no reason. Where it is another service
// (TK-01, 06, 09, 13..15: Notification, the Gateway's own tokenizer, Transaction, Fraud), no client route leads to that
// call, so the answer Privacy really gave is relayed by a stand-in of the downstream host through the real Gateway, as
// before M4-07: that only shows what the Gateway makes of a refusal. TK-07 and TK-10 are in their own tickets; the end-to-end
// run through Newman is M6-01. Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const CUSTOMER = 'CUST-000101';
const ACCOUNT = '1234567801';
const ABSENT = 'PSEU-ABCDEF01';
const A_REQUEST = '11111111-1111-4111-8111-111111111111';

let stack: Stack;
let db: TestDb;
let privacy: ServiceApp;
let gateway: Harness;

beforeEach(async () => {
  stack = await startStack('m306');
  db = stack.privacyDb;
  privacy = stack.privacy;
  gateway = stack.gateway;
});
afterEach(async () => {
  await stack.close();
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

/** What the Gateway tells a client for a call to one of the Gateway's routes, as the client of that role. */
const viaGateway = async (role: 'auditor' | 'admin', path: string, body: object) => {
  const answer = await request(gateway.app.httpServer)
    .post(path)
    .set('authorization', `Bearer ${gateway.tokens.person(role)}`)
    .send(body);
  return { status: answer.status, body: answer.body as { error: Record<string, unknown> } };
};

/**
 * The real path (M4-07): the client of the Gateway asks Reconciliation to open an audit token. The Gateway checks the
 * role, the real Reconciliation checks it again and asks the real Privacy with the same person's token, and whatever
 * Privacy answers comes back masked.
 */
const disclosureViaGateway = (token: string, role: 'auditor' | 'admin' = 'auditor') =>
  viaGateway(role, '/reconciliation/disclosure', { audit_token: token, disclosure_id: A_REQUEST });

/**
 * The relay, for a refusal whose caller has no route for a client (Notification, Transaction, Fraud, the Gateway's own
 * tokenizer): the answer Privacy gave on the wire is returned by the host of Transaction behind a route of the real
 * Gateway. It shows what the Gateway makes of a refusal and nothing about the service that was refused.
 */
async function relayedThroughGateway(relayed: Answer) {
  gateway.network.respond(HOSTS['transaction-service'], () => ({
    status: relayed.status,
    body: relayed.body,
  }));
  const answer = await request(gateway.app.httpServer)
    .get('/transaction/held')
    .set('authorization', `Bearer ${gateway.tokens.person('fraud_analyst')}`);
  return { status: answer.status, body: answer.body as { error: Record<string, unknown> } };
}

interface Scenario {
  readonly tk: string;
  readonly title: string;
  readonly status: number;
  readonly reason: string;
  /** Sets the state up and returns the refused call. */
  readonly run: () => Promise<Answer>;
  /**
   * When the refused caller is Reconciliation: the same state, and the same refusal asked for through the real Gateway
   * and the real Reconciliation. `denials` is how many DENIED rows it leaves in Privacy (none when the Gateway or
   * Reconciliation refuses the role before Privacy is asked).
   */
  readonly real?: {
    readonly run: () => Promise<{ status: number; body: { error: Record<string, unknown> } }>;
    readonly denials: number;
  };
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
    real: { run: async () => disclosureViaGateway(await issueP6()), denials: 1 },
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
    real: {
      run: async () => {
        const token = await issueP7();
        gateway.clock.advance(600 + 30 + 1);
        return disclosureViaGateway(token);
      },
      denials: 1,
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
    real: {
      run: async () => {
        const token = await issueP7();
        expect((await asAdminConsole(`/pseudonym/${token}/revoke`, 'admin', {})).status).toBe(200);
        return disclosureViaGateway(token);
      },
      denials: 1,
    },
  },
  {
    tk: 'TK-05',
    title: 'a random token',
    status: 404,
    reason: 'TOKEN_NOT_FOUND',
    run: () => deIdentify('reconciliation', ABSENT, 'INTERNAL_AUDIT', 'auditor'),
    real: { run: () => disclosureViaGateway(ABSENT), denials: 1 },
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
    // The Gateway refuses an admin on this route before Reconciliation or Privacy hear of it (AZ-07).
    real: { run: async () => disclosureViaGateway(await issueP7(), 'admin'), denials: 0 },
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
    const before = (await denied()).length;
    const seen = scenario.real
      ? await scenario.real.run()
      : await relayedThroughGateway(await scenario.run());
    expect(seen.status).toBe(403);
    expect(seen.body.error).toEqual({
      code: 'ACCESS_DENIED',
      message: expect.any(String) as unknown,
      request_id: expect.any(String) as unknown,
    });
    expect(JSON.stringify(seen.body)).not.toContain(scenario.reason);
    if (scenario.real !== undefined) {
      // Through the real path Privacy was asked once by Reconciliation, and wrote its own DENIED row for the person.
      const rows = await denied();
      expect(rows).toHaveLength(before + scenario.real.denials);
      if (scenario.real.denials > 0) {
        expect(rows[rows.length - 1]).toMatchObject({ reason: scenario.reason });
      }
    }
  });
});

describe('M3-06 NFR-10 a token that exists and one that does not look the same to the client', () => {
  it('M3-06 TK-02 TK-05 through the real Reconciliation the whole answer is identical except request_id', async () => {
    // A token that exists (an account token, the wrong kind to open as an audit) against one that was never made.
    const exists = await disclosureViaGateway(await issueP6());
    const absent = await disclosureViaGateway(ABSENT);
    const bare = ({ status, body }: typeof exists) => ({
      status,
      error: { ...body.error, request_id: undefined },
    });
    expect(exists.status).toBe(403);
    expect(bare(exists)).toEqual(bare(absent));
  });

  it('M3-06 TK-01 TK-05 the same holds for a refusal relayed from another service', async () => {
    const exists = await relayedThroughGateway(
      await call('/resolve-domain', 'notification', { notif_token: await issueFraud() }),
    );
    const absent = await relayedThroughGateway(
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
