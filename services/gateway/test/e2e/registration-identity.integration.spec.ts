import { randomInt } from 'node:crypto';
import request from 'supertest';
import { buildCanary, type Canary } from '../../../../tests/pii-scan/canary';
import { scanText } from '../../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../../tests/pii-scan/scan-database';
import { startStack, type BaselineStack, type Host, type Stack } from './stack';

// Seam: one registration (A1 to A5) through the real Gateway, Privacy and Notification, then the places the data of the
// person can be (G4, G2, G6, Tabel IV). In baseline the A4 payload to Notification holds the customer id, the NIK, the
// name, the account number and the phone, and never the e-mail; Notification keeps the NIK, the name and the account
// number beside the customer id and the phone. In proposed the A4 payload is a token and the phone only. The canary is
// built at run time from a random index, so a value left in a fixture of an earlier run can never satisfy these tests.
// Needs PostgreSQL.
type AnyStack = Stack | BaselineStack;

interface Trail {
  readonly person: Canary;
  readonly a4Bodies: Record<string, unknown>[];
  readonly a4Attributes: string[];
  readonly payloadAttributesByHost: Record<string, string[]>;
  readonly databases: Record<string, string[]>;
  readonly logs: string[];
  readonly everyPayload: string;
  readonly capturedLogLines: number;
}

async function registerOnce(stack: AnyStack): Promise<Trail> {
  const index = randomInt(1000, 99_000);
  const base = buildCanary(index);
  const username = `e2e.g4.${String(index)}`;
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

  const where = (findings: readonly { attribute: string }[]): string[] =>
    findings.map((finding) => finding.attribute).sort();
  const a4 = stack.payloads['notification.test'] ?? [];
  const payloadAttributesByHost: Record<string, string[]> = {};
  for (const [host, bodies] of Object.entries(stack.payloads)) {
    payloadAttributesByHost[host] = where(
      scanText(bodies.join('\n'), [person], { service: host, location: 'payload' }),
    );
  }
  const databases: Record<string, string[]> = {};
  for (const [name, db] of Object.entries(stack.dbs)) {
    databases[name] = (await scanDatabase(db.owner, [person], name)).map(
      (finding) => `${finding.attribute}@${finding.location}`,
    );
  }
  const logHosts = Object.keys(stack.logs) as (Host | 'gateway')[];
  return {
    person,
    a4Bodies: a4.map((body) => JSON.parse(body) as Record<string, unknown>),
    a4Attributes: where(
      scanText(a4.join('\n'), [person], { service: 'notification.test', location: 'payload' }),
    ),
    payloadAttributesByHost,
    databases,
    logs: logHosts.flatMap((host) =>
      scanText(stack.logs[host].join('\n'), [person], { service: host, location: 'log' }).map(
        (finding) => `${finding.attribute}@log:${host}`,
      ),
    ),
    everyPayload: Object.values(stack.payloads).flat().join('\n'),
    capturedLogLines: logHosts.reduce((sum, host) => sum + stack.logs[host].length, 0),
  };
}

describe('G4 G2 G6 Tabel IV baseline: the A4 hop to Notification and its store', () => {
  let trail: Trail;
  beforeAll(async () => {
    const stack = await startStack('g4e', { mode: 'baseline' });
    try {
      trail = await registerOnce(stack);
    } finally {
      await stack.close();
    }
  });

  it('G4 the A4 payload holds exactly the customer id, NIK, name, account number and phone', () => {
    expect(trail.a4Bodies).toHaveLength(1);
    const body = trail.a4Bodies[0] ?? {};
    expect(Object.keys(body).sort()).toEqual(
      ['account_number', 'channel', 'nama', 'nik', 'notification_domain_id', 'phone'].sort(),
    );
    expect(body).toMatchObject({
      notification_domain_id: trail.person.customer_id,
      nik: trail.person.nik,
      nama: trail.person.nama,
      account_number: trail.person.rekening,
      phone: trail.person.hp,
      channel: 'SMS',
    });
  });

  it('G4 the scanner finds exactly five attributes in the A4 payload: customer id, NIK, name, account number, phone', () => {
    expect(trail.a4Attributes).toEqual(['customer_id', 'hp', 'nama', 'nik', 'rekening']);
  });

  it('G6 the Notification database holds the NIK, the name and the account number beside the customer id and the phone', () => {
    expect(trail.databases['notification']).toEqual(
      expect.arrayContaining([
        'nik@contact_registry.nik',
        'nama@contact_registry.nama',
        'rekening@contact_registry.account_number',
        'customer_id@contact_registry.customer_id',
        'hp@contact_registry.phone',
      ]),
    );
  });

  it('G2 the e-mail canary is in no payload of the Gateway to any service, in no database and in no log', () => {
    expect(trail.everyPayload).not.toContain(trail.person.email);
    for (const attributes of Object.values(trail.payloadAttributesByHost)) {
      expect(attributes).not.toContain('email');
    }
    expect(Object.values(trail.databases).flat().join('\n')).not.toContain('email@');
    expect(trail.logs.join('\n')).not.toContain('email');
  });

  it('G4 invariant 6 no log of any service holds any attribute of the person', () => {
    // The capture saw the registration (so an empty result is not an empty capture) and found nothing in it.
    expect(trail.capturedLogLines).toBeGreaterThan(0);
    expect(trail.logs).toEqual([]);
  });

  it('G2 positive control: the same scans find a canary planted in an A4-shaped payload and in a log line', () => {
    const planted = JSON.stringify({
      notification_domain_id: trail.person.customer_id,
      nik: trail.person.nik,
      nama: trail.person.nama,
      account_number: trail.person.rekening,
      phone: trail.person.hp,
      email: trail.person.email,
    });
    expect(
      scanText(planted, [trail.person], { service: 'notification.test', location: 'payload' })
        .map((finding) => finding.attribute)
        .sort(),
    ).toEqual(['customer_id', 'email', 'hp', 'nama', 'nik', 'rekening']);
    expect(
      scanText(`{"event":"x","detail":"${trail.person.nik}"}`, [trail.person], {
        service: 'gateway',
        location: 'log',
      }).map((finding) => finding.attribute),
    ).toEqual(['nik']);
  });
});

describe('G4 G2 G6 the same registration in proposed shows none of it', () => {
  let trail: Trail;
  beforeAll(async () => {
    const stack = await startStack('g4e', { mode: 'proposed' });
    try {
      trail = await registerOnce(stack);
    } finally {
      await stack.close();
    }
  });

  it('G4 the A4 payload is a domain token, the phone and the channel, and the scanner finds only the phone', () => {
    expect(trail.a4Bodies).toHaveLength(1);
    expect(Object.keys(trail.a4Bodies[0] ?? {}).sort()).toEqual(
      ['channel', 'notification_domain_id', 'phone'].sort(),
    );
    expect(trail.a4Attributes).toEqual(['hp']);
  });

  it('G6 the Notification database holds the phone and none of the other attributes', () => {
    expect(trail.databases['notification']).toEqual(['hp@contact_registry.phone']);
  });

  it('G2 the e-mail canary is in no payload, no database and no log', () => {
    expect(trail.everyPayload).not.toContain(trail.person.email);
    expect(Object.values(trail.databases).flat().join('\n')).not.toContain('email@');
    expect(trail.logs).toEqual([]);
  });
});
