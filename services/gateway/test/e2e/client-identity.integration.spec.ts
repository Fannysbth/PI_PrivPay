import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildCanary, type Canary } from '../../../../tests/pii-scan/canary';
import { scanText } from '../../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../../tests/pii-scan/scan-database';
import { startStack, type BaselineStack, type Host, type Stack } from './stack';

// Seam: one payment through the real Gateway, Transaction and Fraud, then the places the data of the person can be
// (G3, G6, Tabel IV). In baseline the Fraud payload holds the customer id, the NIK, the name and the account number and
// nothing else of the person (no phone, no e-mail), and the Transaction and Fraud databases keep NIK and name (and, in
// Fraud, the account number). In proposed none of it shows anywhere. The canary is built at run time from a random
// index, so a value that was left in a fixture of an earlier run can never satisfy these tests. Needs PostgreSQL.
type AnyStack = Stack | BaselineStack;

interface Trail {
  readonly person: Canary;
  readonly fraudBodies: Record<string, unknown>[];
  readonly fraudPayloadAttributes: string[];
  readonly databases: Record<string, string[]>;
  readonly logs: string[];
  readonly everyPayloadExceptPrivacy: string;
}

async function payOnce(stack: AnyStack): Promise<Trail> {
  const index = randomInt(1000, 99_000);
  const base = buildCanary(index);
  const username = `e2e.g3.${String(index)}`;
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
  // 2 000 000 is over the Fraud threshold, so Transaction does ask Fraud.
  const paid = await request(stack.gateway.httpServer)
    .post('/transaction')
    .set('authorization', `Bearer ${await stack.login('customer-app', username)}`)
    .set('idempotency-key', randomUUID())
    .send({
      source_account: person.rekening,
      merchant_id: 'MRC-001',
      amount: 2_000_000,
      geohash: 'qqgu4',
      nik: person.nik,
      nama: person.nama,
    });
  expect(paid.status).toBe(201);

  const where = (findings: readonly { attribute: string }[]): string[] =>
    findings.map((finding) => finding.attribute).sort();
  const fraudPayloads = stack.payloads['fraud.test'] ?? [];
  const databases: Record<string, string[]> = {};
  for (const [name, db] of Object.entries(stack.dbs)) {
    databases[name] = (await scanDatabase(db.owner, [person], name)).map(
      (finding) => `${finding.attribute}@${finding.location}`,
    );
  }
  return {
    person,
    fraudBodies: fraudPayloads.map((body) => JSON.parse(body) as Record<string, unknown>),
    fraudPayloadAttributes: where(
      scanText(fraudPayloads.join('\n'), [person], { service: 'fraud.test', location: 'payload' }),
    ),
    databases,
    logs: (Object.keys(stack.logs) as (Host | 'gateway')[]).flatMap((host) =>
      scanText(stack.logs[host].join('\n'), [person], { service: host, location: 'log' }).map(
        (finding) => `${finding.attribute}@log:${host}`,
      ),
    ),
    everyPayloadExceptPrivacy: Object.entries(stack.payloads)
      .filter(([host]) => host !== 'privacy.test')
      .flatMap(([, bodies]) => bodies)
      .join('\n'),
  };
}

describe('G3 G6 Tabel IV baseline: the Transaction to Fraud hop and the two stores', () => {
  let trail: Trail;
  beforeAll(async () => {
    const stack = await startStack('g3e', { mode: 'baseline' });
    try {
      trail = await payOnce(stack);
    } finally {
      await stack.close();
    }
  });

  it('G3 the Fraud payload holds exactly the customer id, NIK, name and account number besides the numbers', () => {
    expect(trail.fraudBodies).toHaveLength(1);
    const body = trail.fraudBodies[0] ?? {};
    expect(Object.keys(body).sort()).toEqual(
      ['account_number', 'amount', 'geohash', 'nama', 'nik', 'pseudonym', 'tx_hour'].sort(),
    );
    expect(body).toMatchObject({
      pseudonym: trail.person.customer_id,
      nik: trail.person.nik,
      nama: trail.person.nama,
      account_number: trail.person.rekening,
    });
  });

  it('G3 the scanner finds four attributes in the Fraud payload and neither the phone nor the e-mail', () => {
    expect(trail.fraudPayloadAttributes).toEqual(['customer_id', 'nama', 'nik', 'rekening']);
  });

  it('G6 the Transaction database holds the NIK and the name beside the customer id and the account number', () => {
    expect(trail.databases['transaction']).toEqual(
      expect.arrayContaining([
        'nik@transactions.nik',
        'nama@transactions.nama',
        'customer_id@transactions.customer_id',
        'rekening@transactions.account_number',
      ]),
    );
  });

  it('G6 the Fraud database holds the NIK, the name and the account number beside the customer id', () => {
    expect(trail.databases['fraud']).toEqual(
      expect.arrayContaining([
        'nik@fraud_assessments.nik',
        'nama@fraud_assessments.nama',
        'rekening@fraud_assessments.account_number',
        'customer_id@fraud_assessments.customer_id',
      ]),
    );
  });

  it('G3 the e-mail is forwarded nowhere: no payload to any service but Privacy (absent here) holds it', () => {
    expect(
      scanText(trail.everyPayloadExceptPrivacy, [trail.person], {
        service: 'all',
        location: 'payload',
      }).map((finding) => finding.attribute),
    ).not.toContain('email');
    expect(JSON.stringify(trail.databases)).not.toContain('email@');
  });

  it('G3 invariant 6 no log of any service holds any attribute of the person', () => {
    expect(trail.logs).toEqual([]);
  });

  it('G3 positive control: the same scan finds a canary that is planted in a Fraud-shaped payload and a log line', () => {
    const planted = JSON.stringify({
      pseudonym: trail.person.customer_id,
      nik: trail.person.nik,
      nama: trail.person.nama,
      account_number: trail.person.rekening,
      email: trail.person.email,
    });
    expect(
      scanText(planted, [trail.person], { service: 'fraud.test', location: 'payload' }).map(
        (finding) => finding.attribute,
      ),
    ).toEqual(expect.arrayContaining(['customer_id', 'nik', 'nama', 'rekening', 'email']));
  });
});

describe('G3 G6 the same payment in proposed shows none of it', () => {
  let trail: Trail;
  beforeAll(async () => {
    const stack = await startStack('g3e', { mode: 'proposed' });
    try {
      trail = await payOnce(stack);
    } finally {
      await stack.close();
    }
  });

  it('G3 the Fraud payload is the four fields of a token and numbers, and the scanner finds nothing in it', () => {
    expect(trail.fraudBodies).toHaveLength(1);
    expect(Object.keys(trail.fraudBodies[0] ?? {}).sort()).toEqual(
      ['amount', 'geohash', 'pseudonym', 'tx_hour'].sort(),
    );
    expect(trail.fraudPayloadAttributes).toEqual([]);
  });

  it('G6 neither the Transaction nor the Fraud database holds any attribute of the person', () => {
    expect(trail.databases['transaction']).toEqual([]);
    expect(trail.databases['fraud']).toEqual([]);
  });

  it('G3 no log of any service holds any attribute of the person', () => {
    expect(trail.logs).toEqual([]);
  });
});
