import { randomUUID } from 'node:crypto';
import { buildCanary } from '../pii-scan/canary';
import { scanText } from '../pii-scan/scan';
import { call, docker, edge, KONG_PORT, login, logs, MODE, PROJECT, runIndex } from './helpers';

// DK-02b: what the services behind the edge hold after a registration and a payment made through Kong. In the proposed
// condition the edge tokenized, so the downstream databases and logs hold PSEU- tokens and no canary (the phone in the
// Notification registry is the deliberate exception). In baseline the data is real, and the scan MUST find it: that is the
// positive control, without which "nothing found" would prove nothing.
//
// Needs the running stack of PRIVPAY_STACK_MODE (proposed by default), started with docs/postman/compose.postman.yml.
// Every value is generated here (fictional canary); nothing is printed except attribute names.
const canary = buildCanary(runIndex(0));
const username = `uji.payload.${canary.nik.slice(-6)}`;

// Each dump and log is taken once, after the payment: the data does not change while the tests read it.
const taken = new Map<string, string>();
const once = (key: string, take: () => string): string => {
  let text = taken.get(key);
  if (text === undefined) {
    text = take();
    taken.set(key, text);
  }
  return text;
};
const dump = (service: string): string =>
  once(`dump:${service}`, () =>
    docker([
      'exec',
      `${PROJECT}-pg-${service}-1`,
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      `privpay_${service}`,
      '--data-only',
    ]),
  );
const attributes = (text: string): string[] =>
  scanText(text, [canary], { service: 'x', location: 'x' }).map((finding) => finding.attribute);

describe(`DK-02b payload scan of the downstream services (${MODE})`, () => {
  beforeAll(async () => {
    const registered = await call(
      { port: KONG_PORT, path: '/register', tls: true },
      {
        nik: canary.nik,
        nama: canary.nama,
        hp: canary.hp,
        email: canary.email,
        rekening: canary.rekening,
        username,
      },
    );
    expect(registered.status).toBe(201);
    const token = await login(username);
    const key = randomUUID();
    const paid = await edge(
      '/transaction',
      { authorization: `Bearer ${token}`, 'idempotency-key': key },
      {
        source_account: canary.rekening,
        merchant_id: 'MRC-001',
        amount: 35000,
        geohash: 'qqgu4',
      },
    );
    expect(paid.status).toBe(201);
  }, 60_000);

  it('DK-02b no log of the edge or of a service holds a canary value', () => {
    const services = [
      'kong',
      'gateway',
      'transaction-service',
      'fraud-service',
      'notification-service',
      'reconciliation-service',
    ];
    for (const service of services)
      expect({ service, found: attributes(once(`log:${service}`, () => logs(service))) }).toEqual({
        service,
        found: [],
      });
  });

  if (MODE === 'proposed') {
    it('DK-02b the databases of Transaction, Fraud and Reconciliation hold tokens and no canary', () => {
      expect(dump('transaction')).toMatch(/PSEU-[0-9A-F]{8}/);
      for (const service of ['transaction', 'fraud', 'reconciliation']) {
        expect({ service, found: attributes(dump(service)) }).toEqual({ service, found: [] });
      }
    });

    it('DK-02b the Notification registry holds the phone and nothing else (the one deliberate exception)', () => {
      expect(attributes(dump('notification'))).toEqual(['hp']);
    });
  } else {
    it('DK-02b control: in baseline the same scan finds the real account number in Transaction', () => {
      expect(attributes(dump('transaction'))).toContain('rekening');
      expect(dump('transaction')).not.toMatch(/PSEU-[0-9A-F]{8}/);
    });
  }
});
