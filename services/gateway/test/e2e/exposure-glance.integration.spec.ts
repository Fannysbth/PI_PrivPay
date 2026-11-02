import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildCanary, type Canary } from '../../../../tests/pii-scan/canary';
import { scanText } from '../../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../../tests/pii-scan/scan-database';
import { startStack, type BaselineStack, type Host, type Stack } from './stack';

// A glance at E(s) (Tabel IV of Metodologi v9), NOT the official measurement (that is M6-02): one registration, two payments
// (one above the Fraud threshold), a bank report and a run, through the real services, then for each downstream service the
// attributes of P = {nama, NIK, phone, e-mail, account number, customer id} found in what it RECEIVED, in its DATABASE and
// in the LOGS. The expectations below are the values of Tabel IV written down before this was run; nothing here is tuned to
// make them match: if a number differs, the test fails and the difference is reported. Canaries are built at run time.
type AnyStack = Stack | BaselineStack;
type Service = 'transaction' | 'fraud' | 'notification' | 'reconciliation';

const TABLE_IV: Record<'baseline' | 'proposed', Record<Service, string[]>> = {
  baseline: {
    transaction: ['customer_id', 'nama', 'nik', 'rekening'],
    fraud: ['customer_id', 'nama', 'nik', 'rekening'],
    notification: ['customer_id', 'hp', 'nama', 'nik', 'rekening'],
    reconciliation: ['customer_id', 'nama', 'nik', 'rekening'],
  },
  proposed: { transaction: [], fraud: [], notification: ['hp'], reconciliation: [] },
};

const HOST: Record<Service, Host> = {
  transaction: 'transaction.test',
  fraud: 'fraud.test',
  notification: 'notification.test',
  reconciliation: 'reconciliation.test',
};

interface Glance {
  readonly received: Record<Service, string[]>;
  readonly stored: Record<Service, string[]>;
  readonly logs: string[];
  readonly person: Canary;
}

const attributes = (findings: readonly { attribute: string }[]): string[] =>
  [...new Set(findings.map((finding) => finding.attribute))].sort();

async function glance(stack: AnyStack): Promise<Glance> {
  const index = randomInt(1000, 99_000);
  const base = buildCanary(index);
  const username = `e2e.glance.${String(index)}`;
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
  for (const amount of [35_000, 2_000_000]) {
    const paid = await request(stack.gateway.httpServer)
      .post('/transaction')
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', randomUUID())
      .send({
        source_account: person.rekening,
        merchant_id: 'MRC-001',
        amount,
        geohash: 'qqgu4',
        nik: person.nik,
        nama: person.nama,
      });
    expect(paid.status).toBe(201);
  }
  const date = stack.clock.now().toISOString().slice(0, 10);
  const bank = await request(stack.gateway.httpServer)
    .post('/settlement/report')
    .set('authorization', `Bearer ${await stack.login('bank-simulator', 'bank.uji.1')}`)
    .send({
      batch_date: date,
      items: [{ account_number: person.rekening, amount: 35_000, bank_reference: 'BNK-GL-0001' }],
    });
  expect(bank.status).toBe(202);
  // What Reconciliation reads is the answer of Transaction and Privacy from here on.
  stack.responses['transaction.test'] = [];
  stack.responses['privacy.test'] = [];
  const ran = await request(stack.gateway.httpServer)
    .post('/reconciliation/run')
    .set('authorization', `Bearer ${await stack.login('admin-console', 'admin.uji.1')}`)
    .send({ date });
  expect(ran.status).toBe(200);

  const scan = (text: string, service: string, location: string) =>
    attributes(scanText(text, [person], { service, location }));
  const received: Record<Service, string[]> = {
    transaction: scan(
      (stack.payloads['transaction.test'] ?? []).join('\n'),
      'transaction',
      'payload',
    ),
    fraud: scan((stack.payloads['fraud.test'] ?? []).join('\n'), 'fraud', 'payload'),
    notification: scan(
      (stack.payloads['notification.test'] ?? []).join('\n'),
      'notification',
      'payload',
    ),
    reconciliation: scan(
      [
        ...(stack.payloads['reconciliation.test'] ?? []),
        ...(stack.responses['transaction.test'] ?? []),
        ...(stack.responses['privacy.test'] ?? []),
      ].join('\n'),
      'reconciliation',
      'payload',
    ),
  };
  const stored = {} as Record<Service, string[]>;
  for (const service of Object.keys(HOST) as Service[]) {
    stored[service] = attributes(await scanDatabase(stack.dbs[service].owner, [person], service));
  }
  return {
    person,
    received,
    stored,
    logs: (Object.keys(stack.logs) as (Host | 'gateway')[]).flatMap((host) =>
      scan(stack.logs[host].join('\n'), host, 'log').map((attribute) => `${attribute}@log:${host}`),
    ),
  };
}

/** The union of what a service received and what it keeps, the way E(s) = |P(s)| / |P| counts it. */
const exposure = (g: Glance, service: Service): string[] =>
  [...new Set([...g.received[service], ...g.stored[service]])].sort();

describe.each(['baseline', 'proposed'] as const)('G-glance E(s) in %s against Tabel IV', (mode) => {
  let seen: Glance;
  beforeAll(async () => {
    const stack = await startStack('glance', { mode });
    try {
      seen = await glance(stack);
    } finally {
      await stack.close();
    }
  });

  it.each(['transaction', 'fraud', 'notification', 'reconciliation'] as const)(
    `G-glance ${mode} %s: the attributes seen are those of Tabel IV`,
    (service) => {
      expect(exposure(seen, service)).toEqual(TABLE_IV[mode][service]);
    },
  );

  it('G-glance no log of any service holds any attribute of the person', () => {
    expect(seen.logs).toEqual([]);
  });

  it('G-glance the e-mail is in no service, in either place', () => {
    for (const service of Object.keys(HOST) as Service[]) {
      expect(exposure(seen, service)).not.toContain('email');
    }
  });
});
