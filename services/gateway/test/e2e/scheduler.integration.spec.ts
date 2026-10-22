import { randomUUID } from 'node:crypto';
import { SCHEDULER, type Scheduler } from '@privpay/common';
import { FakeTimers } from '@privpay/common/testing';
import request from 'supertest';
import { startStack, type Host, type Stack } from './stack';

// Seam: the jobs of the services, wired to their life cycle (M4-10, K-19, K-23, K-26), with the real services behind
// them and a FakeClock and FakeTimers in place of time: nothing waits, and the test decides when a timer goes off. The
// retention job (Privacy), the cleaner of PENDING rows and of the status Privacy has not heard (Transaction) and the
// daily reconciliation (Reconciliation) each do their work on the real databases. Needs PostgreSQL and bootstrap.ps1.
const timers = {
  privacy: new FakeTimers(),
  transaction: new FakeTimers(),
  reconciliation: new FakeTimers(),
};
let stack: Stack;
let day = 9;

const schedulerOf = (host: Host): Scheduler =>
  stack.apps[host].app.get<Scheduler>(SCHEDULER, { strict: false });
/** The timer of a service going off, and the jobs it started ending. */
const fire = async (service: keyof typeof timers, host: Host): Promise<void> => {
  timers[service].fire();
  await schedulerOf(host).idle();
};

beforeAll(async () => {
  stack = await startStack('m410', { timers });
  // The jobs start when the services listen, not before.
  for (const host of ['privacy.test', 'transaction.test', 'reconciliation.test'] as const) {
    expect(stack.apps[host].app.get<Scheduler>(SCHEDULER, { strict: false })).toBeDefined();
  }
  expect([timers.privacy.arms, timers.transaction.arms, timers.reconciliation.arms]).toEqual([
    0, 0, 0,
  ]);
  for (const host of ['privacy.test', 'transaction.test', 'reconciliation.test'] as const) {
    await stack.apps[host].listen();
  }
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.reset();
  day += 1;
  stack.clock.set(`2026-10-${String(day).padStart(2, '0')}T12:05:00.000Z`);
});

const today = (): string => stack.clock.now().toISOString().slice(0, 10);
const pay = async () => {
  const token = await stack.login('customer-app', 'nasabah.uji.101');
  return request(stack.gateway.httpServer)
    .post('/transaction')
    .set('authorization', `Bearer ${token}`)
    .set('idempotency-key', randomUUID())
    .send({
      source_account: '1234567801',
      merchant_id: 'MRC-001',
      amount: 35_000,
      geohash: 'qqgu4',
    });
};
const privacyStatus = async (id: string): Promise<string | undefined> =>
  (
    await stack.dbs.privacy.owner.query<{ status: string }>(
      'SELECT status FROM transaction_status WHERE transaction_id = $1',
      [id],
    )
  ).rows[0]?.status;

describe('M4-10 the jobs start with the service and are described by what the environment said', () => {
  it('M4-10 K-19 K-23 K-26 each service has the jobs and the schedule of its environment, and its timer was armed when it listened', () => {
    expect(schedulerOf('privacy.test').describe()).toEqual([
      { name: 'retention', schedule: { kind: 'daily', runUtc: '01:00' } },
    ]);
    expect(schedulerOf('transaction.test').describe()).toEqual([
      { name: 'pending-cleaner', schedule: { kind: 'every', seconds: 30 } },
    ]);
    expect(schedulerOf('reconciliation.test').describe()).toEqual([
      { name: 'daily-reconciliation', schedule: { kind: 'daily', runUtc: '00:10' } },
    ]);
    for (const timer of Object.values(timers)) expect(timer.arms).toBeGreaterThan(0);
  });

  it('M4-10 the services that have no jobs have no scheduler', () => {
    for (const host of ['gateway', 'fraud.test', 'notification.test', 'sms.test'] as const) {
      expect(() => {
        stack.apps[host].app.get<Scheduler>(SCHEDULER, { strict: false });
      }).toThrow();
    }
  });
});

describe('M4-10 K-19 the cleaner of Transaction runs by itself', () => {
  it('M4-10 FR-39 TF-17 a PENDING row past the timeout is failed when the timer goes off, and Privacy is told', async () => {
    await stack.dbs.transaction.owner.query(
      `INSERT INTO transactions (transaction_id, idempotency_key, customer_pseudonym, account_pseudonym,
          merchant_id, amount, geohash, status, created_at)
        VALUES ('TX-9101', $1, 'PSEU-00000001', 'PSEU-00000002', 'MRC-001', 35000, 'qqgu4', 'PENDING', $2)`,
      [randomUUID(), new Date(stack.clock.now().getTime() - 400_000)],
    );
    stack.clock.advance(31);
    await fire('transaction', 'transaction.test');
    const row = await stack.dbs.transaction.owner.query('SELECT status FROM transactions');
    expect(row.rows).toEqual([{ status: 'FAILED' }]);
    expect(await privacyStatus('TX-9101')).toBe('FAILED');
  });

  it('M4-10 FR-10 a PATCH that Privacy never heard is repeated by the timer, and the message is not sent again', async () => {
    stack.fail('privacy.test', '/transaction-status');
    const paid = await pay();
    expect(paid.body).toMatchObject({ status: 'COMPLETED' });
    const id = (paid.body as { transaction_id: string }).transaction_id;
    expect(await privacyStatus(id)).toBeUndefined();
    const sent = (await request(stack.apps['sms.test'].httpServer).get('/__test/messages'))
      .body as {
      messages: unknown[];
    };

    stack.fail('privacy.test', '/transaction-status', 0);
    // Inside the window of a request in flight the cleaner leaves it alone; past it, it repeats the PATCH.
    stack.clock.advance(301);
    await fire('transaction', 'transaction.test');
    expect(await privacyStatus(id)).toBe('COMPLETED');
    const after = (await request(stack.apps['sms.test'].httpServer).get('/__test/messages'))
      .body as {
      messages: unknown[];
    };
    expect(after.messages).toHaveLength(sent.messages.length);
  });

  it('M4-10 the timer is armed again after it went off, so the cleaner goes on', async () => {
    const before = timers.transaction.arms;
    stack.clock.advance(31);
    await fire('transaction', 'transaction.test');
    expect(timers.transaction.arms).toBeGreaterThan(before);
    expect(timers.transaction.armed).toBeDefined();
  });
});

describe('M4-10 K-23 the daily reconciliation runs by itself', () => {
  it('M4-10 K-23 at RECON_DAILY_RUN_UTC it reconciles the day before, once', async () => {
    const yesterday = today();
    stack.clock.set(
      `${new Date(Date.parse(`${yesterday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:10:00.000Z`,
    );
    await fire('reconciliation', 'reconciliation.test');
    const batches = await stack.dbs.reconciliation.owner.query<{
      batch_id: string;
      status: string;
    }>('SELECT batch_id, status FROM settlement_batches');
    expect(batches.rows).toEqual([
      { batch_id: `B-${yesterday.replaceAll('-', '')}`, status: 'MATCHED' },
    ]);
    // The same minute again: nothing is run twice.
    const asked = stack.calls.filter((c) => c.includes('/transaction/completed')).length;
    await fire('reconciliation', 'reconciliation.test');
    expect(stack.calls.filter((c) => c.includes('/transaction/completed')).length).toBe(asked);
  });

  it('M4-10 K-22 a Transaction that is away fails the run, which is logged by reason and does not stop the service', async () => {
    stack.clock.set(
      `${new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:10:00.000Z`,
    );
    stack.down.add('transaction.test');
    await fire('reconciliation', 'reconciliation.test');
    stack.down.delete('transaction.test');
    expect(stack.logs['reconciliation.test'].join('\n')).toContain(
      'job_failed_daily-reconciliation',
    );
    expect(stack.logs['reconciliation.test'].join('\n')).toContain('SERVICE_UNAVAILABLE');
    const health = await request(stack.apps['reconciliation.test'].httpServer).get('/health');
    expect(health.status).toBe(200);
  });
});

describe('M4-10 K-26 the retention job of Privacy runs by itself', () => {
  it('M4-10 FR-31 S-36 at RETENTION_JOB_RUN_UTC a token past its life is marked expired, and once it is 90 days past it holds no identity', async () => {
    const paid = await pay();
    expect(paid.status).toBe(201);
    const rows = async () =>
      (
        await stack.dbs.privacy.owner.query<{ status: string; kept: boolean }>(
          `SELECT status, subject_id_enc IS NOT NULL AS kept FROM pseudonym_mapping
            WHERE purpose = 'PAYMENT_PROCESSING' ORDER BY id`,
        )
      ).rows;
    expect(new Set((await rows()).map((r) => `${r.status}/${String(r.kept)}`))).toEqual(
      new Set(['active/true']),
    );
    const at = (days: number): string =>
      `${new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)}T01:00:00.000Z`;

    // The next morning: past its life, but still inside the 90 days the identity is kept.
    stack.clock.set(at(1));
    await fire('privacy', 'privacy.test');
    expect(new Set((await rows()).map((r) => `${r.status}/${String(r.kept)}`))).toEqual(
      new Set(['expired/true']),
    );
    // 91 days later the same job empties it: the check of S-36 finds nothing left.
    stack.clock.set(at(91));
    await fire('privacy', 'privacy.test');
    expect(new Set((await rows()).map((r) => `${r.status}/${String(r.kept)}`))).toEqual(
      new Set(['expired/false']),
    );
    const left = await stack.dbs.privacy.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pseudonym_mapping
        WHERE subject_id_enc IS NOT NULL AND expires_at < $1::timestamptz - interval '90 days'`,
      [stack.clock.now()],
    );
    expect(left.rows[0]?.n).toBe('0');
    expect(stack.logs['privacy.test'].join('\n')).not.toContain('job_failed');
  });
});
