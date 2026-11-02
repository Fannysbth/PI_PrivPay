import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildCanary, type Canary } from '../../../../tests/pii-scan/canary';
import { scanText } from '../../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../../tests/pii-scan/scan-database';
import { startStack, type BaselineStack, type Host, type Stack } from './stack';

// Seam: one registration, one payment, one bank report and one run through the real Gateway, Transaction and Reconciliation,
// then what Reconciliation RECEIVED and where it keeps it (G5, G6, Tabel IV). In baseline Transaction names the customer id,
// the NIK, the name and the account number of each completed transaction, and a matched item keeps the first three beside
// the account number the bank reported; the phone and the e-mail reach it nowhere. In proposed Reconciliation receives and
// keeps none of it. The canary is built at run time from a random index, so a value left in a fixture of an earlier run can
// never satisfy these tests. Needs PostgreSQL.
type AnyStack = Stack | BaselineStack;

interface Trail {
  readonly person: Canary;
  readonly run: { status: number; body: unknown };
  readonly received: string[];
  readonly receivedAttributes: string[];
  readonly reconciliationDb: string[];
  readonly logs: string[];
}

const where = (findings: readonly { attribute: string }[]): string[] =>
  [...new Set(findings.map((finding) => finding.attribute))].sort();

async function reconcileOnce(stack: AnyStack): Promise<Trail> {
  const index = randomInt(1000, 99_000);
  const base = buildCanary(index);
  const username = `e2e.g5.${String(index)}`;
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
  // Under the Fraud threshold, so the payment completes at once and the day has one completed transaction.
  const paid = await request(stack.gateway.httpServer)
    .post('/transaction')
    .set('authorization', `Bearer ${token}`)
    .set('idempotency-key', randomUUID())
    .send({
      source_account: person.rekening,
      merchant_id: 'MRC-001',
      amount: 35_000,
      geohash: 'qqgu4',
      nik: person.nik,
      nama: person.nama,
    });
  expect(paid.status).toBe(201);
  const date = stack.clock.now().toISOString().slice(0, 10);
  const bank = await request(stack.gateway.httpServer)
    .post('/settlement/report')
    .set('authorization', `Bearer ${await stack.login('bank-simulator', 'bank.uji.1')}`)
    .send({
      batch_date: date,
      items: [{ account_number: person.rekening, amount: 35_000, bank_reference: 'BNK-G5-0001' }],
    });
  expect(bank.status).toBe(202);

  // From here on only what the run itself reads is kept: the answers of Transaction and Privacy, and the bodies that came to
  // Reconciliation.
  stack.responses['transaction.test'] = [];
  stack.responses['privacy.test'] = [];
  const ran = await request(stack.gateway.httpServer)
    .post('/reconciliation/run')
    .set('authorization', `Bearer ${await stack.login('admin-console', 'admin.uji.1')}`)
    .send({ date });
  const received = [
    ...(stack.payloads['reconciliation.test'] ?? []),
    ...(stack.responses['transaction.test'] ?? []),
    ...(stack.responses['privacy.test'] ?? []),
  ];
  const findings = await scanDatabase(stack.dbs.reconciliation.owner, [person], 'reconciliation');
  return {
    person,
    run: { status: ran.status, body: ran.body },
    received,
    receivedAttributes: where(
      scanText(received.join('\n'), [person], {
        service: 'reconciliation.test',
        location: 'payload',
      }),
    ),
    reconciliationDb: findings.map((finding) => `${finding.attribute}@${finding.location}`),
    logs: (Object.keys(stack.logs) as (Host | 'gateway')[]).flatMap((host) =>
      scanText(stack.logs[host].join('\n'), [person], { service: host, location: 'log' }).map(
        (finding) => `${finding.attribute}@log:${host}`,
      ),
    ),
  };
}

describe('G5 G6 Tabel IV baseline: what Reconciliation receives and keeps', () => {
  let trail: Trail;
  beforeAll(async () => {
    const stack = await startStack('g5e', { mode: 'baseline' });
    try {
      trail = await reconcileOnce(stack);
    } finally {
      await stack.close();
    }
  });

  it('G5 the day is reconciled as before: one transaction, one item, MATCHED', () => {
    expect(trail.run.status).toBe(200);
    expect(trail.run.body).toMatchObject({
      tx_count: 1,
      matched: 1,
      unmatched: 0,
      status: 'MATCHED',
    });
  });

  it('G5 the scanner finds the customer id, NIK, name and account number in what Reconciliation received, and neither phone nor e-mail', () => {
    expect(trail.receivedAttributes).toEqual(['customer_id', 'nama', 'nik', 'rekening']);
  });

  it('G6 the Reconciliation database holds the customer id, NIK and name of the matched item beside the account number', () => {
    expect(trail.reconciliationDb).toEqual(
      expect.arrayContaining([
        'customer_id@settlement_items.customer_id',
        'nik@settlement_items.nik',
        'nama@settlement_items.nama',
        'rekening@settlement_items.account_number',
      ]),
    );
    expect(trail.reconciliationDb.join(' ')).not.toMatch(/email|hp@/);
  });

  it('G5 invariant 6 no log of any service holds any attribute of the person', () => {
    expect(trail.logs).toEqual([]);
  });

  it('G5 positive control: the same scan finds a canary planted in a payload that Reconciliation could receive', () => {
    const planted = JSON.stringify({
      customer_id: trail.person.customer_id,
      nik: trail.person.nik,
      nama: trail.person.nama,
      account_number: trail.person.rekening,
      email: trail.person.email,
    });
    expect(
      scanText(planted, [trail.person], {
        service: 'reconciliation.test',
        location: 'payload',
      }).map((finding) => finding.attribute),
    ).toEqual(expect.arrayContaining(['customer_id', 'nik', 'nama', 'rekening', 'email']));
  });
});

describe('G5 G6 the same day in proposed shows none of it in Reconciliation', () => {
  let trail: Trail;
  beforeAll(async () => {
    const stack = await startStack('g5e', { mode: 'proposed' });
    try {
      trail = await reconcileOnce(stack);
    } finally {
      await stack.close();
    }
  });

  it('G5 the day is reconciled with tokens: one transaction, one item, MATCHED', () => {
    expect(trail.run.status).toBe(200);
    expect(trail.run.body).toMatchObject({
      tx_count: 1,
      matched: 1,
      unmatched: 0,
      status: 'MATCHED',
    });
  });

  it('G5 what Reconciliation received holds no attribute of the person', () => {
    expect(trail.received.length).toBeGreaterThan(0);
    expect(trail.receivedAttributes).toEqual([]);
  });

  it('G6 the Reconciliation database holds no attribute of the person', () => {
    expect(trail.reconciliationDb).toEqual([]);
  });

  it('G5 no log of any service holds any attribute of the person', () => {
    expect(trail.logs).toEqual([]);
  });
});
