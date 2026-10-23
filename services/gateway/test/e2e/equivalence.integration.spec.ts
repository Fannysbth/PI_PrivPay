import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildCanary, type Canary } from '../../../../tests/pii-scan/canary';
import { scanText } from '../../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../../tests/pii-scan/scan-database';
import { startStack, type BaselineStack, type Host, type Stack } from './stack';

// Seam: the same business scenario through the real Gateway and every real service, once in each mode (M5-02, ADR-0006
// no. 5, FR-23). The two runs must give the same answers, rows and messages: that is what makes a difference between the
// modes in M7 a difference of the privacy layer and not of the business logic. And the mode must really change something:
// after the run the scan finds the real data of a person in the baseline databases and nowhere in the proposed ones. The
// persons are fictitious; each stack has its own FakeClock. Needs PostgreSQL and scripts/db/bootstrap.ps1.
type AnyStack = Stack | BaselineStack;

interface Payment {
  readonly user: 101 | 102 | 103;
  readonly account: string;
  readonly merchant: string;
  readonly amount: number;
  readonly geohash: string;
}
const TX_10001: Payment = {
  user: 101,
  account: '1234567801',
  merchant: 'MRC-001',
  amount: 35_000,
  geohash: 'qqgu4',
};
const TX_10002: Payment = {
  user: 102,
  account: '1234567802',
  merchant: 'MRC-002',
  amount: 8_000_000,
  geohash: 'qqt8h',
};
const TX_10003: Payment = {
  user: 103,
  account: '1234567803',
  merchant: 'MRC-003',
  amount: 1_500_000,
  geohash: 'qqgu4',
};
const HISTORY_102: Payment = { ...TX_10002, amount: 2_000_000, geohash: 'qqgu7' };

/** What a user of the system can see of one run. Nothing in it names a token, an identity or a transaction id. */
interface Observed {
  readonly phones: number[];
  readonly normal: { status: number; body: string };
  readonly replay: { status: number; sameTransaction: boolean };
  readonly held: { status: number; body: string };
  readonly heldList: { amount: number; risk_score: number; fraud_decision: string }[];
  readonly approve: { status: number; body: string };
  readonly approveAgain: { status: number; code: string };
  readonly fraudDown: { status: number; body: string };
  readonly report: number;
  readonly reconciliation: { status: number; body: unknown };
  readonly rows: Record<string, unknown>[];
  readonly messages: { to: string; text: string }[];
}

async function observe(stack: AnyStack, day: number): Promise<Observed> {
  const gateway = stack.gateway.httpServer;
  stack.clock.set(`2026-10-${String(day).padStart(2, '0')}T12:05:00.000Z`);
  const date = (): string => stack.clock.now().toISOString().slice(0, 10);
  const goTo = (hour: number, minute: number): void => {
    stack.clock.set(
      `${date()}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`,
    );
  };
  const analyst = (): Promise<string> => stack.login('admin-console', 'analis.uji.1');
  const pay = async (payment: Payment, key = randomUUID()) =>
    request(gateway)
      .post('/transaction')
      .set(
        'authorization',
        `Bearer ${await stack.login('customer-app', `nasabah.uji.${String(payment.user)}`)}`,
      )
      .set('idempotency-key', key)
      .send({
        source_account: payment.account,
        merchant_id: payment.merchant,
        amount: payment.amount,
        geohash: payment.geohash,
      });
  const bodyOf = (answer: request.Response) =>
    answer.body as { transaction_id: string; status: string };

  const phones: number[] = [];
  for (const n of [101, 102, 103]) {
    const token = await stack.login('customer-app', `nasabah.uji.${String(n)}`);
    const set = await request(gateway)
      .post('/notification/register')
      .set('authorization', `Bearer ${token}`)
      .send({ phone: `0812000000${String(n - 100).padStart(2, '0')}`, channel: 'SMS' });
    phones.push(set.status);
  }

  const key = randomUUID();
  const first = await pay(TX_10001, key);
  const second = await pay(TX_10001, key);
  const normal = { status: first.status, body: bodyOf(first).status };
  const replay = {
    status: second.status,
    sameTransaction: bodyOf(second).transaction_id === bodyOf(first).transaction_id,
  };

  await pay(HISTORY_102);
  goTo(23, 15);
  const suspicious = await pay(TX_10002);
  const held = { status: suspicious.status, body: bodyOf(suspicious).status };
  const listed = await request(gateway)
    .get('/transaction/held')
    .set('authorization', `Bearer ${await analyst()}`);
  const heldList = (
    listed.body as { items: { amount: number; risk_score: number; fraud_decision: string }[] }
  ).items.map(({ amount, risk_score, fraud_decision }) => ({ amount, risk_score, fraud_decision }));
  stack.clock.advance(120);
  const review = (decision: string, reason: string) =>
    analyst().then((token) =>
      request(gateway)
        .post(`/transaction/${bodyOf(suspicious).transaction_id}/review`)
        .set('authorization', `Bearer ${token}`)
        .send({ decision, reason_code: reason }),
    );
  const approved = await review('APPROVE', 'CONFIRMED_BY_CUSTOMER');
  const approve = { status: approved.status, body: bodyOf(approved).status };
  const again = await review('REJECT', 'OTHER');
  const approveAgain = {
    status: again.status,
    code: (again.body as { error: { code: string } }).error.code,
  };

  stack.down.add('fraud.test');
  const unavailable = await pay(TX_10003);
  stack.down.delete('fraud.test');
  const fraudDown = { status: unavailable.status, body: bodyOf(unavailable).status };

  const bank = await stack.login('bank-simulator', 'bank.uji.1');
  const sent = await request(gateway)
    .post('/settlement/report')
    .set('authorization', `Bearer ${bank}`)
    .send({
      batch_date: date(),
      items: [
        { account_number: TX_10001.account, amount: 35_000, bank_reference: 'BNK-0001' },
        { account_number: HISTORY_102.account, amount: 2_000_000, bank_reference: 'BNK-0002' },
        { account_number: TX_10002.account, amount: 8_000_000, bank_reference: 'BNK-0003' },
      ],
    });
  const ran = await request(gateway)
    .post('/reconciliation/run')
    .set('authorization', `Bearer ${await stack.login('admin-console', 'admin.uji.1')}`)
    .send({ date: date() });

  const rows = (
    await stack.dbs.transaction.owner.query<Record<string, unknown>>(
      `SELECT status, fraud_decision, risk_score::text AS risk_score, merchant_id, amount::text AS amount,
              reviewed_by, (completed_at IS NULL) AS open
         FROM transactions ORDER BY amount, merchant_id, status`,
    )
  ).rows;
  const messages = (
    (await request(stack.apps['sms.test'].httpServer).get('/__test/messages')).body as {
      messages: { to: string; text: string }[];
    }
  ).messages;
  return {
    phones,
    normal,
    replay,
    held,
    heldList,
    approve,
    approveAgain,
    fraudDown,
    report: sent.status,
    reconciliation: { status: ran.status, body: ran.body },
    rows,
    messages,
  };
}

/** Where the data of one person ended up: `attribute@place`. */
async function whereIsThe(stack: AnyStack, person: Canary, answers: unknown[]): Promise<string[]> {
  const found: string[] = [];
  const note = (place: string, findings: readonly { attribute: string }[]) =>
    found.push(...findings.map((f) => `${f.attribute}@${place}`));
  for (const [name, db] of Object.entries(stack.dbs)) {
    note(`${name}-db`, await scanDatabase(db.owner, [person], name));
  }
  for (const host of Object.keys(stack.logs) as (Host | 'gateway')[]) {
    note(
      `log:${host}`,
      scanText(stack.logs[host].join('\n'), [person], { service: host, location: 'log' }),
    );
  }
  // The bodies the services sent each other. Privacy is the one place that may receive the raw identity (invariant 1).
  for (const [host, bodies] of Object.entries(stack.payloads)) {
    if (host === 'privacy.test') continue;
    note(
      `payload:${host}`,
      scanText(bodies.join('\n'), [person], { service: host, location: 'payload' }),
    );
  }
  note(
    'answers',
    scanText(JSON.stringify(answers), [person], { service: 'gateway', location: 'answers' }),
  );
  const messages = (
    (await request(stack.apps['sms.test'].httpServer).get('/__test/messages')).body as {
      messages: { to: string; text: string }[];
    }
  ).messages;
  note(
    'sms',
    scanText(JSON.stringify(messages), [person], { service: 'sms', location: 'messages' }),
  );
  return found.sort();
}

/** A person registers, pays, is held and approved; returns what the scan finds and the person it looked for. */
async function leaveATrail(stack: AnyStack, index: number): Promise<string[]> {
  const base = buildCanary(index);
  const username = `e2e.scan.${String(index)}`;
  const registered = await request(stack.gateway.httpServer).post('/register').send({
    nik: base.nik,
    nama: base.nama,
    hp: base.hp,
    email: base.email,
    rekening: base.rekening,
    username,
  });
  expect(registered.status).toBe(201);
  const token = await stack.login('customer-app', username);
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { customer_id: string };
  const person: Canary = { ...base, customer_id: claims.customer_id };
  const answers: unknown[] = [registered.body];
  const pay = async (amount: number, geohash: string) =>
    request(stack.gateway.httpServer)
      .post('/transaction')
      .set('authorization', `Bearer ${await stack.login('customer-app', username)}`)
      .set('idempotency-key', randomUUID())
      // The client sends its NIK and name too (FR-03 lets it); proposed drops them, baseline passes them on (G1).
      .send({
        source_account: person.rekening,
        merchant_id: 'MRC-001',
        amount,
        geohash,
        nik: person.nik,
        nama: person.nama,
      });
  answers.push((await pay(35_000, 'qqgu4')).body);
  answers.push((await pay(2_000_000, 'qqgu7')).body);
  stack.clock.set(`${stack.clock.now().toISOString().slice(0, 10)}T23:15:00.000Z`);
  answers.push((await pay(8_000_000, 'qqt8h')).body);
  return whereIsThe(stack, person, answers);
}

const observed = {} as { proposed: Observed; baseline: Observed };
const trail = {} as { proposed: string[]; baseline: string[] };

describe('M5-02 FR-23 ADR-0006 the same scenario in proposed and in baseline', () => {
  it('M5-02 FR-23 proposed: the run is the one of M4-09 and the scan finds only the phone', async () => {
    const stack = await startStack('m502e', { paymentTtl: '60', grace: '10' });
    try {
      observed.proposed = await observe(stack, 6);
      await stack.reset();
      stack.clock.set('2026-10-07T12:05:00.000Z');
      trail.proposed = await leaveATrail(stack, 81);
    } finally {
      await stack.close();
    }
    expect(observed.proposed.held).toEqual({ status: 201, body: 'HELD' });
    expect(observed.proposed.heldList).toEqual([
      { amount: 8_000_000, risk_score: 75, fraud_decision: 'HOLD_FOR_VERIFICATION' },
    ]);
    expect(observed.proposed.reconciliation.body).toMatchObject({
      tx_count: 3,
      matched: 3,
      unmatched: 0,
      status: 'MATCHED',
    });
  });

  it('M5-02 FR-23 baseline: the same scenario runs without Privacy, and Privacy is never even tried', async () => {
    const stack = await startStack('m502e', { mode: 'baseline', paymentTtl: '60', grace: '10' });
    try {
      observed.baseline = await observe(stack, 6);
      expect(stack.attempted.some((call) => call.includes('privacy.test'))).toBe(false);
      await stack.reset();
      stack.clock.set('2026-10-07T12:05:00.000Z');
      trail.baseline = await leaveATrail(stack, 81);
      expect(stack.attempted.some((call) => call.includes('privacy.test'))).toBe(false);
    } finally {
      await stack.close();
    }
  });

  it('M5-02 FR-23 TF-02 TF-03 TF-04 TF-05 TF-09 TF-11 both modes give the same answers, the same rows and the same messages', () => {
    expect(observed.baseline).toEqual(observed.proposed);
  });

  it('M5-02 FR-23 the scenario is not trivially equal: it completes, holds, approves, refuses a second decision and reconciles', () => {
    const run = observed.baseline;
    expect(run.normal).toEqual({ status: 201, body: 'COMPLETED' });
    expect(run.replay).toEqual({ status: 200, sameTransaction: true });
    expect(run.approve).toEqual({ status: 200, body: 'COMPLETED' });
    expect(run.approveAgain).toEqual({ status: 409, code: 'NOT_HELD' });
    expect(run.fraudDown).toEqual({ status: 201, body: 'HELD' });
    expect(run.report).toBe(202);
    expect(run.messages.length).toBeGreaterThanOrEqual(5);
  });

  it('M5-02 FR-23 FR-42 the mode changes what is kept: proposed keeps no identity, baseline keeps the real data and the scan finds it', () => {
    // Proposed: the phone is where it must be (Notification, the SMS simulator) and nowhere else.
    expect(trail.proposed).toEqual([
      'hp@notification-db',
      'hp@payload:notification.test',
      // DF13: the SMS provider is sent the phone and the text; the simulator stands in for it.
      'hp@payload:sms.test',
      'hp@sms',
    ]);
    // Baseline: the scan MUST find real data, in the services that key by the identity. If it found nothing the scanner
    // would be blind, and the equality above would prove nothing about privacy.
    expect(trail.baseline).toEqual(
      expect.arrayContaining([
        'customer_id@transaction-db',
        'rekening@transaction-db',
        'customer_id@fraud-db',
        'customer_id@notification-db',
        'hp@notification-db',
        'hp@sms',
        // G1: what the Gateway passes on to Transaction in baseline, seen on the wire and not in a table.
        'nik@payload:transaction.test',
        'nama@payload:transaction.test',
        'customer_id@payload:transaction.test',
        'rekening@payload:transaction.test',
      ]),
    );
    expect(trail.baseline.length).toBeGreaterThan(trail.proposed.length);
  });

  it('M5 G7 FR-42 NFR-17 baseline keeps real data in its tables and on the wire, but no log and no answer to the client holds any', () => {
    // The logger takes fields from a list in both modes, so the data of baseline is where the design puts it and not in
    // the places that outlive a request. If this fails, a log line carries an identity in baseline.
    const loose = trail.baseline.filter((place) => /@(log:|answers)/.test(place));
    expect(loose).toEqual([]);
    expect(trail.proposed.filter((place) => /@(log:|answers)/.test(place))).toEqual([]);
  });
});
