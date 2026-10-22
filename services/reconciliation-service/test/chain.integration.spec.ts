import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import request from 'supertest';
import { bankSimulatorModules } from '../../bank-simulator/src/bank-simulator.module';
import { startStack, through, type Stack } from './support/stack';
import { PRD16_COMPLETED } from './fakes';

// Seam: the whole D3 and D4 path with the real Gateway, Privacy and Reconciliation and the real bank simulator: the
// bank sends its report with account numbers, the Gateway tokenises it, Reconciliation stores tokens and matches them
// with the transactions of the day. Only the network, the IdP and Transaction are doubles. The accounts are the
// fictitious ones of PRD 16. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const DATE = '2026-10-05';
const ACCOUNTS = ['1234567801', '1234567803', '1234567899'];

let stack: Stack;
let bank: ServiceApp;

beforeEach(async () => {
  stack = await startStack('m406c');
  stack.transactions.completed = PRD16_COMPLETED;
  bank = await createServiceApp(
    {
      service: 'bank-simulator',
      modules: bankSimulatorModules({
        fetch: async (input, init) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.hostname === 'idp.test') {
            return new Response(
              JSON.stringify({
                access_token: stack.gateway.tokens.bank(),
                token_type: 'Bearer',
                expires_in: 300,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return through(stack.gateway.app, url, init);
        },
      }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      IDP_URL: 'http://idp.test',
      IDP_ISSUER: 'privpay-dev-idp',
      GATEWAY_URL: 'http://gateway.test',
      BANK_USERNAME: 'bank.uji.1',
      BANK_SIMULATOR_TEST_ENDPOINTS: 'true',
    },
    { clock: stack.gateway.clock },
  );
});
afterEach(async () => {
  await bank.close();
  await stack.close();
});

/** B3: the Gateway issues the account token of a payment (P2) for the account of a transaction of PRD 16. */
async function payment(transactionId: string, account: string): Promise<void> {
  const answer = await stack.toPrivacy('api-gateway', '/pseudonymize', {
    subject_type: 'ACCOUNT',
    subject_id: account,
    target_service: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transaction_id: transactionId,
  });
  expect(answer.status).toBe(200);
}
const simulate = (body: object) => request(bank.httpServer).post('/simulate/settlement').send(body);
const runDay = () =>
  request(stack.gateway.app.httpServer)
    .post('/reconciliation/run')
    .set('authorization', `Bearer ${stack.gateway.tokens.person('admin')}`)
    .send({ date: DATE });
const tokensIssued = async (): Promise<number> => {
  const found = await stack.privacyDb.owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE action = 'GENERATE_TOKEN'`,
  );
  return Number(found.rows[0]?.n);
};

describe('M4-06 TF-13 TF-16 FR-32 the bank report through the Gateway into Reconciliation', () => {
  beforeEach(async () => {
    await payment('TX-10001', '1234567801');
    await payment('TX-10003', '1234567803');
  });

  it('M4-06 TF-13 the valid report is tokenised by the Gateway, stored by Reconciliation, and the day is B-20261005, 2, 2, 0, MATCHED', async () => {
    const sent = await simulate({ batch_date: DATE });
    expect(sent.body).toMatchObject({ sent_items: 2, gateway_status: 202 });
    const ran = await runDay();
    expect(ran.status).toBe(200);
    expect(ran.body).toEqual({
      batch_id: 'B-20261005',
      tx_count: 2,
      matched: 2,
      unmatched: 0,
      status: 'MATCHED',
    });
    const total = await stack.reconciliationDb.owner.query<{ total_amount: string }>(
      'SELECT total_amount FROM settlement_batches',
    );
    expect(total.rows[0]?.total_amount).toBe('1535000.00');
  });

  it('M4-06 FR-32 no account number of the bank is in reconciliation-db or its log, only tokens', async () => {
    await simulate({ batch_date: DATE, inject: ['UNPAIRED'] });
    await runDay();
    const dump = JSON.stringify(
      (await stack.reconciliationDb.owner.query('SELECT * FROM settlement_items')).rows,
    );
    for (const account of ACCOUNTS) {
      expect(dump).not.toContain(account);
      expect(stack.logs.reconciliation.join('\n')).not.toContain(account);
    }
    expect(dump).toMatch(/PSEU-[0-9A-F]{8}/);
  });

  it.each([['EMPTY_ACCOUNT'], ['NEGATIVE_AMOUNT']])(
    'M4-06 TF-13 %s makes the Gateway answer 422, and no token is issued and nothing is stored',
    async (fault) => {
      const before = await tokensIssued();
      const sent = await simulate({ batch_date: DATE, inject: [fault] });
      expect(sent.body).toMatchObject({ gateway_status: 422 });
      expect(await tokensIssued()).toBe(before);
      expect(
        (await stack.reconciliationDb.owner.query('SELECT 1 FROM settlement_batches')).rowCount,
      ).toBe(0);
    },
  );

  it('M4-06 TF-16 a line the bank has and the platform has not leaves the day PARTIAL', async () => {
    const sent = await simulate({ batch_date: DATE, inject: ['UNPAIRED'] });
    expect(sent.body).toMatchObject({ sent_items: 3, gateway_status: 202 });
    expect((await runDay()).body).toMatchObject({
      tx_count: 2,
      matched: 2,
      unmatched: 1,
      status: 'PARTIAL',
    });
  });

  it('M4-06 K-22 the same report again is 200 and a different one is 409 IDEMPOTENCY_CONFLICT, both through the Gateway', async () => {
    await simulate({ batch_date: DATE });
    expect((await simulate({ batch_date: DATE })).body).toMatchObject({ gateway_status: 200 });
    const different = await simulate({ batch_date: DATE, inject: ['UNPAIRED'] });
    expect(different.body).toMatchObject({
      gateway_status: 409,
      gateway_body: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    });
  });

  it('M4-06 AZ-08 an auditor cannot start the run through the Gateway', async () => {
    const answer = await request(stack.gateway.app.httpServer)
      .post('/reconciliation/run')
      .set('authorization', `Bearer ${stack.gateway.tokens.person('auditor')}`)
      .send({ date: DATE });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
  });
});
