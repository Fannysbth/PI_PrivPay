import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildCanary, type Canary } from '../../../../tests/pii-scan/canary';
import { scanText } from '../../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../../tests/pii-scan/scan-database';
import { startStack, type Host, type Stack } from './stack';

// Seam: the transactions of PRD 16 end to end, through the real Gateway, with the real IdP, Privacy, Transaction, Fraud,
// Notification, the SMS simulator and Reconciliation behind it (M4-09). TX-10001 completes under the threshold, TX-10002
// is held with score 75 and decided by an analyst through the Gateway, TX-10003 loses its tokens to their TTL in the
// middle and gets them again (TF-04). Also: a block, a Fraud that is gone (HELD, never COMPLETED), a Privacy that is gone
// (nothing happens), the reconciliation of the day with the held one left out, and the scan of everything that was left
// behind. The payment token lives 60 s here (a JWT lives 300 s), so it can end between two steps. The persons are
// fictitious; the clock is one FakeClock that only moves forward, a day per test. Needs PostgreSQL and bootstrap.ps1.
let stack: Stack;
let day = 4;

beforeAll(async () => {
  stack = await startStack('m409', { paymentTtl: '60', grace: '10' });
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.reset();
  day += 1;
  stack.clock.set(`2026-10-${String(day).padStart(2, '0')}T12:05:00.000Z`);
  // Each customer says where the messages go (AZ-02), as the phones of PRD 16.
  for (const n of [101, 102, 103]) {
    const token = await stack.login('customer-app', `nasabah.uji.${String(n)}`);
    const set = await request(stack.gateway.httpServer)
      .post('/notification/register')
      .set('authorization', `Bearer ${token}`)
      .send({ phone: `0812000000${String(n - 100).padStart(2, '0')}`, channel: 'SMS' });
    expect(set.status).toBe(200);
  }
  stack.calls.length = 0;
});

const date = (): string => stack.clock.now().toISOString().slice(0, 10);
const goTo = (hour: number, minute = 0): void => {
  stack.clock.set(
    `${date()}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`,
  );
};

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
/** The earlier payment of customer 102 that gives Fraud a history (h01 of PRD 16): 2.000.000 at a normal hour, elsewhere. */
const HISTORY_102: Payment = { ...TX_10002, amount: 2_000_000, geohash: 'qqgu7' };

const pay = async (payment: Payment, key = randomUUID()) => {
  const token = await stack.login('customer-app', `nasabah.uji.${String(payment.user)}`);
  return request(stack.gateway.httpServer)
    .post('/transaction')
    .set('authorization', `Bearer ${token}`)
    .set('idempotency-key', key)
    .send({
      source_account: payment.account,
      merchant_id: payment.merchant,
      amount: payment.amount,
      geohash: payment.geohash,
    });
};
const analyst = () => stack.login('admin-console', 'analis.uji.1');
const rowsOf = async () =>
  (
    await stack.dbs.transaction.owner.query<Record<string, unknown>>(
      'SELECT * FROM transactions ORDER BY created_at, transaction_id',
    )
  ).rows;
const rowOf = async (id: string) => (await rowsOf()).find((row) => row['transaction_id'] === id);
const privacyStatus = async (id: string): Promise<string | undefined> =>
  (
    await stack.dbs.privacy.owner.query<{ status: string }>(
      'SELECT status FROM transaction_status WHERE transaction_id = $1',
      [id],
    )
  ).rows[0]?.status;
const messages = async (): Promise<{ to: string; text: string }[]> =>
  (
    (await request(stack.apps['sms.test'].httpServer).get('/__test/messages')).body as {
      messages: { to: string; text: string }[];
    }
  ).messages;
const auditCount = async (action: string, status?: string): Promise<number> =>
  Number(
    (
      await stack.dbs.privacy.owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR status = $2)`,
        [action, status ?? null],
      )
    ).rows[0]?.n,
  );

describe('M4-09 TF-02 TX-10001: a normal payment under the threshold', () => {
  it('M4-09 TF-02 FR-16 the payment completes without asking Fraud; Privacy and the customer are told; Transaction holds tokens only', async () => {
    const answer = await pay(TX_10001);
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ status: 'COMPLETED' });
    const id = (answer.body as { transaction_id: string }).transaction_id;
    expect(stack.calls.some((c) => c.includes('fraud.test'))).toBe(false);
    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: 'COMPLETED',
      fraud_decision: null,
      merchant_id: 'MRC-001',
    });
    expect(row?.['customer_pseudonym']).toMatch(/^PSEU-[0-9A-F]{8}$/);
    expect(row?.['account_pseudonym']).toMatch(/^PSEU-[0-9A-F]{8}$/);
    expect(await privacyStatus(id)).toBe('COMPLETED');
    expect(await messages()).toEqual([{ to: '081200000001', text: 'Transaksi Rp35000 berhasil.' }]);
  });

  it('M4-09 FR-36 NFR-23 the same payment sent twice with the same key is one transaction and one message', async () => {
    const key = randomUUID();
    const first = await pay(TX_10001, key);
    const second = await pay(TX_10001, key);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect((second.body as { transaction_id: string }).transaction_id).toBe(
      (first.body as { transaction_id: string }).transaction_id,
    );
    expect(await rowsOf()).toHaveLength(1);
    expect(await messages()).toHaveLength(1);
  });
});

describe('M4-09 TF-03 TX-10002: a suspicious payment is held with score 75', () => {
  /** h01, then the payment of 8.000.000 at 23:15 from another place. */
  const suspicious = async () => {
    expect((await pay(HISTORY_102)).status).toBe(201);
    goTo(23, 15);
    const answer = await pay(TX_10002);
    return answer.body as { transaction_id: string; status: string };
  };

  it('M4-09 TF-03 FR-40 the score is 75 (10 + 25 + 20 + 20), the transaction is HELD, Privacy says IN_PROGRESS, the customer is told it is being verified', async () => {
    const held = await suspicious();
    expect(held.status).toBe('HELD');
    expect(await rowOf(held.transaction_id)).toMatchObject({
      status: 'HELD',
      fraud_decision: 'HOLD_FOR_VERIFICATION',
      risk_score: '75.00',
      completed_at: null,
    });
    expect(await privacyStatus(held.transaction_id)).toBe('IN_PROGRESS');
    expect((await messages()).at(-1)).toEqual({
      to: '081200000002',
      text: 'Transaksi Rp8000000 sedang diverifikasi.',
    });
  });

  it('M4-09 AZ-04 FR-34 the analyst sees it through the Gateway with amount, score and decision, and no token or identity', async () => {
    const held = await suspicious();
    const list = await request(stack.gateway.httpServer)
      .get('/transaction/held')
      .set('authorization', `Bearer ${await analyst()}`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      items: [
        {
          transaction_id: held.transaction_id,
          amount: 8_000_000,
          risk_score: 75,
          fraud_decision: 'HOLD_FOR_VERIFICATION',
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(list.body)).not.toMatch(/PSEU-|CUST-|1234567802|nasabah/);
  });

  it('M4-09 AZ-05 FR-35 APPROVE through the Gateway completes it: reviewed_by is the analyst of the token, Privacy and the customer are told', async () => {
    const held = await suspicious();
    stack.clock.advance(120);
    const review = await request(stack.gateway.httpServer)
      .post(`/transaction/${held.transaction_id}/review`)
      .set('authorization', `Bearer ${await analyst()}`)
      .send({ decision: 'APPROVE', reason_code: 'CONFIRMED_BY_CUSTOMER' });
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ transaction_id: held.transaction_id, status: 'COMPLETED' });
    expect(await rowOf(held.transaction_id)).toMatchObject({
      status: 'COMPLETED',
      reviewed_by: 'usr-fraud-01',
    });
    expect(await privacyStatus(held.transaction_id)).toBe('COMPLETED');
    expect((await messages()).at(-1)?.text).toBe('Transaksi Rp8000000 berhasil.');
    // A second decision on the same transaction is NOT_HELD, and nothing is sent again.
    const sent = (await messages()).length;
    const again = await request(stack.gateway.httpServer)
      .post(`/transaction/${held.transaction_id}/review`)
      .set('authorization', `Bearer ${await analyst()}`)
      .send({ decision: 'REJECT', reason_code: 'OTHER' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'NOT_HELD' } });
    expect((await messages()).length).toBe(sent);
  });

  it('M4-09 AZ-05 REJECT through the Gateway fails it and tells the customer it was refused', async () => {
    const held = await suspicious();
    const review = await request(stack.gateway.httpServer)
      .post(`/transaction/${held.transaction_id}/review`)
      .set('authorization', `Bearer ${await analyst()}`)
      .send({ decision: 'REJECT', reason_code: 'SUSPECTED_FRAUD' });
    expect(review.body).toMatchObject({ status: 'FAILED' });
    expect(await privacyStatus(held.transaction_id)).toBe('FAILED');
    expect((await messages()).at(-1)?.text).toBe('Transaksi Rp8000000 ditolak.');
  });

  it('M4-09 AZ-04 AZ-05 N1 N2 only a fraud analyst: no credential is 401, a customer, an admin and an auditor are 403, and nothing is decided', async () => {
    const held = await suspicious();
    const path = `/transaction/${held.transaction_id}/review`;
    const body = { decision: 'APPROVE', reason_code: 'OTHER' };
    expect((await request(stack.gateway.httpServer).get('/transaction/held')).status).toBe(401);
    expect((await request(stack.gateway.httpServer).post(path).send(body)).status).toBe(401);
    const others = [
      await stack.login('customer-app', 'nasabah.uji.101'),
      await stack.login('admin-console', 'admin.uji.1'),
      await stack.login('admin-console', 'auditor.uji.1'),
    ];
    for (const token of others) {
      for (const answer of [
        await request(stack.gateway.httpServer)
          .get('/transaction/held')
          .set('authorization', `Bearer ${token}`),
        await request(stack.gateway.httpServer)
          .post(path)
          .set('authorization', `Bearer ${token}`)
          .send(body),
      ]) {
        expect(answer.status).toBe(403);
        expect(answer.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
      }
    }
    expect(await rowOf(held.transaction_id)).toMatchObject({ status: 'HELD', reviewed_by: null });
  });
});

describe('M4-09 FR-40 NFR-24 TF-11 a block, and a Fraud that is gone', () => {
  it('M4-09 FR-37 a score of 90 or more is BLOCK: FAILED, Privacy FAILED, the customer is told it was refused', async () => {
    // The weights are read at run time (K-20): with the new one the same payment as TX-10002 scores 120.
    await stack.dbs.fraud.owner.query(
      `UPDATE risk_rules SET weight = 70 WHERE rule = 'AMOUNT_OVER_3X_AVG'`,
    );
    try {
      expect((await pay(HISTORY_102)).status).toBe(201);
      goTo(23, 15);
      const blocked = await pay(TX_10002);
      const id = (blocked.body as { transaction_id: string }).transaction_id;
      expect(blocked.body).toMatchObject({ status: 'FAILED' });
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', fraud_decision: 'BLOCK' });
      expect(await privacyStatus(id)).toBe('FAILED');
      expect((await messages()).at(-1)?.text).toBe('Transaksi Rp8000000 ditolak.');
    } finally {
      await stack.dbs.fraud.owner.query(
        `UPDATE risk_rules SET weight = 25 WHERE rule = 'AMOUNT_OVER_3X_AVG'`,
      );
    }
  });

  it('M4-09 NFR-24 TF-11 Fraud down: an amount at the threshold is HELD with FRAUD_UNAVAILABLE and never COMPLETED; a small one is not affected', async () => {
    stack.down.add('fraud.test');
    const big = await pay(TX_10003);
    const small = await pay(TX_10001);
    expect(big.status).toBe(201);
    expect(big.body).toMatchObject({ status: 'HELD' });
    expect(small.body).toMatchObject({ status: 'COMPLETED' });
    const id = (big.body as { transaction_id: string }).transaction_id;
    expect(await rowOf(id)).toMatchObject({
      status: 'HELD',
      fraud_decision: 'FRAUD_UNAVAILABLE',
      completed_at: null,
    });
    expect(await privacyStatus(id)).toBe('IN_PROGRESS');
    expect(
      (await messages()).some((m) => m.text === 'Transaksi Rp1500000 sedang diverifikasi.'),
    ).toBe(true);
  });

  it('M4-09 invariant 8 Privacy down: the payment is refused with 503 before anything is made, and no message is sent', async () => {
    stack.down.add('privacy.test');
    const answer = await pay(TX_10001);
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(await rowsOf()).toEqual([]);
    expect(await messages()).toEqual([]);
    expect(stack.calls.some((c) => c.includes('transaction.test'))).toBe(false);
  });
});

describe('M4-09 TF-04 TX-10003: the tokens end in the middle and are issued again', () => {
  it('M4-09 TF-04 FR-10 the exchange for Fraud finds the token expired, both tokens are re-issued once, the payment completes and the customer is told', async () => {
    // The third call to Privacy for a token is the exchange for Fraud (the Gateway made the first two): 71 s later the
    // payment token (60 s and 10 s of grace) has ended, while every JWT (300 s) is still good.
    let issued = 0;
    stack.hook = (host, _method, path) => {
      if (host === 'privacy.test' && path === '/pseudonymize') {
        issued += 1;
        if (issued === 3) stack.clock.advance(71);
      }
    };
    const answer = await pay(TX_10003);
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ status: 'COMPLETED' });
    const id = (answer.body as { transaction_id: string }).transaction_id;
    expect(await auditCount('EXCHANGE_TOKEN', 'DENIED')).toBe(1);
    expect(await auditCount('RE_ISSUE', 'SUCCESS')).toBe(2);
    expect(await rowOf(id)).toMatchObject({ status: 'COMPLETED', fraud_decision: 'ALLOW' });
    expect(await privacyStatus(id)).toBe('COMPLETED');
    expect(await messages()).toEqual([
      { to: '081200000003', text: 'Transaksi Rp1500000 berhasil.' },
    ]);
    // After the end, Privacy refuses to issue again: the customer was told first (TX_TERMINAL for a later re-issue).
    expect(await auditCount('RE_ISSUE', 'DENIED')).toBe(0);
  });
});

describe('M4-09 FR-21 TF-05 the day is reconciled, and the held transaction is not in it', () => {
  it('M4-09 FR-21 TX-10001 and TX-10003 (1.535.000) match the bank report, TX-10002 stays out: 2, 2, 0, MATCHED', async () => {
    // In the order of the day: the clock only moves forward.
    expect((await pay(TX_10001)).status).toBe(201);
    expect((await pay(TX_10003)).status).toBe(201);
    expect((await pay(HISTORY_102)).status).toBe(201);
    goTo(23, 15);
    expect(((await pay(TX_10002)).body as { status: string }).status).toBe('HELD');

    const bank = await stack.login('bank-simulator', 'bank.uji.1');
    const report = await request(stack.gateway.httpServer)
      .post('/settlement/report')
      .set('authorization', `Bearer ${bank}`)
      .send({
        batch_date: date(),
        items: [
          { account_number: TX_10001.account, amount: 35_000, bank_reference: 'BNK-0001' },
          { account_number: TX_10003.account, amount: 1_500_000, bank_reference: 'BNK-0003' },
          { account_number: HISTORY_102.account, amount: 2_000_000, bank_reference: 'BNK-0002' },
        ],
      });
    expect(report.status).toBe(202);
    const ran = await request(stack.gateway.httpServer)
      .post('/reconciliation/run')
      .set('authorization', `Bearer ${await stack.login('admin-console', 'admin.uji.1')}`)
      .send({ date: date() });
    expect(ran.status).toBe(200);
    // The history payment (2.000.000) completed too, so three transactions of the day are completed and all three match.
    expect(ran.body).toMatchObject({ tx_count: 3, matched: 3, unmatched: 0, status: 'MATCHED' });
    const batch = await stack.dbs.reconciliation.owner.query<{ total_amount: string }>(
      'SELECT total_amount FROM settlement_batches',
    );
    expect(batch.rows[0]?.total_amount).toBe('3535000.00');
  });
});

describe('M4-09 FR-16 FR-18 FR-21 FR-42 D-08 where the data of a person ends, over the whole flow', () => {
  it('M4-09 the NIK, name, email, account and customer id of a person who registers and pays are in no table in the clear, log, metric or answer; the phone is only in Notification and the SMS simulator', async () => {
    counterForCanary += 1;
    const base = buildCanary(80 + counterForCanary);
    const username = 'e2e.scan.user';
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
    ) as {
      customer_id: string;
    };
    const person: Canary = { ...base, customer_id: claims.customer_id };

    const answers: unknown[] = [registered.body];
    // A normal payment, and a held one (through the history, the hour and another place), from the account of the form.
    const pay_ = async (amount: number, geohash: string) =>
      request(stack.gateway.httpServer)
        .post('/transaction')
        .set('authorization', `Bearer ${await stack.login('customer-app', username)}`)
        .set('idempotency-key', randomUUID())
        .send({ source_account: person.rekening, merchant_id: 'MRC-001', amount, geohash });
    const normal = await pay_(35_000, 'qqgu4');
    answers.push(normal.body);
    expect(normal.status).toBe(201);
    answers.push((await pay_(2_000_000, 'qqgu7')).body);
    goTo(23, 15);
    const held = await pay_(8_000_000, 'qqt8h');
    answers.push(held.body);
    expect(held.body).toMatchObject({ status: 'HELD' });
    const review = await request(stack.gateway.httpServer)
      .post(`/transaction/${(held.body as { transaction_id: string }).transaction_id}/review`)
      .set('authorization', `Bearer ${await analyst()}`)
      .send({ decision: 'APPROVE', reason_code: 'CONFIRMED_BY_CUSTOMER' });
    answers.push(
      review.body,
      (
        await request(stack.gateway.httpServer)
          .get('/transaction/held')
          .set('authorization', `Bearer ${await analyst()}`)
      ).body,
    );

    const where = async (): Promise<string[]> => {
      const found: string[] = [];
      const note = (place: string, findings: readonly { attribute: string }[]) =>
        found.push(...findings.map((f) => `${f.attribute}@${place}`));
      note('privacy-db', await scanDatabase(stack.dbs.privacy.owner, [person], 'privacy'));
      note(
        'transaction-db',
        await scanDatabase(stack.dbs.transaction.owner, [person], 'transaction'),
      );
      note('fraud-db', await scanDatabase(stack.dbs.fraud.owner, [person], 'fraud'));
      note(
        'notification-db',
        await scanDatabase(stack.dbs.notification.owner, [person], 'notification'),
      );
      note(
        'reconciliation-db',
        await scanDatabase(stack.dbs.reconciliation.owner, [person], 'reconciliation'),
      );
      for (const host of Object.keys(stack.logs) as (Host | 'gateway')[]) {
        note(
          `log:${host}`,
          scanText(stack.logs[host].join('\n'), [person], { service: host, location: 'log' }),
        );
        const metrics = await request(stack.apps[host].httpServer).get('/metrics');
        note(
          `metrics:${host}`,
          scanText(metrics.text, [person], { service: host, location: 'metrics' }),
        );
      }
      const audit = await stack.dbs.privacy.owner.query('SELECT * FROM audit_log');
      note(
        'privacy-audit',
        scanText(JSON.stringify(audit.rows), [person], { service: 'privacy', location: 'audit' }),
      );
      note(
        'answers',
        scanText(JSON.stringify(answers), [person], { service: 'gateway', location: 'answers' }),
      );
      note(
        'sms',
        scanText(JSON.stringify(await messages()), [person], {
          service: 'sms',
          location: 'messages',
        }),
      );
      return found.sort();
    };
    // The phone is where it must be: the contact registry of Notification, and the messages of the simulator. Nowhere else.
    expect(await where()).toEqual(['hp@notification-db', 'hp@sms']);
    // The control: the scan does find the account number where it is put on purpose.
    expect(
      scanText(JSON.stringify({ source_account: person.rekening }), [person], {
        service: 'x',
        location: 'control',
      }),
    ).toHaveLength(1);
    // The vault holds NIK, name and account, but as ciphertext, once.
    const vault = await stack.dbs.privacy.owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM identity_vault WHERE nik_enc IS NOT NULL AND nama_enc IS NOT NULL AND rekening_enc IS NOT NULL',
    );
    expect(vault.rows[0]?.n).toBe('1');
  });
});

let counterForCanary = 0;
