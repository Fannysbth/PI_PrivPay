import { proposedContactRepository } from '../src/proposed';
import { join } from 'node:path';
import { FakeClock, DomainError, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { NotificationService, type PrivacyClient, type SmsGateway } from '../src/notification';

// Seam: NotificationService.register and .send (spec notification 3) on the real notification database, as the real
// runtime role, with a FakeClock and fake Privacy and SMS adapters that count their calls. The phone numbers and the
// tokens are invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const DOMAIN = 'PSEU-D0A1B2C3';
const NOTIF_TOKEN = 'PSEU-1111AAAA';
const PHONE = '081200000042';
const OTHER_PHONE = '081200000043';

let db: TestDb;
let clock: FakeClock;
let service: NotificationService;
let resolved: string[];
let sent: { to: string; text: string }[];
let privacy: PrivacyClient;
let sms: SmsGateway;
let privacyFails = false;
let smsFails = false;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'notification', suffix: 'm405' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  resolved = [];
  sent = [];
  privacyFails = false;
  smsFails = false;
  privacy = {
    resolveDomain: (token) => {
      resolved.push(token);
      return privacyFails
        ? Promise.reject(new DomainError('SERVICE_UNAVAILABLE'))
        : Promise.resolve(DOMAIN);
    },
  };
  sms = {
    send: (to, text) => {
      sent.push({ to, text });
      return smsFails ? Promise.reject(new DomainError('SERVICE_UNAVAILABLE')) : Promise.resolve();
    },
  };
  service = new NotificationService({
    contacts: proposedContactRepository(db.app),
    privacy,
    sms,
    clock,
  });
});
afterEach(async () => {
  await db.close();
});

const rows = async (table: string) =>
  (await db.owner.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows;
const register = (phone = PHONE) =>
  service.register({ notificationDomainId: DOMAIN, phone, channel: 'SMS' });
const send = (over: Partial<Parameters<NotificationService['send']>[0]> = {}) =>
  service.send({
    notifToken: NOTIF_TOKEN,
    template: 'TX_COMPLETED',
    amount: 35000,
    transactionId: 'TX-1',
    ...over,
  });

describe('M4-05 FR-19 TF-01 register', () => {
  it('M4-05 FR-19 TF-01 the first registration creates the contact, the second updates the phone and creates no second row', async () => {
    const first = await register();
    expect(first).toEqual({
      created: true,
      notificationDomainId: DOMAIN,
      registeredAt: clock.now(),
    });
    clock.advance(3600);
    const again = await register(OTHER_PHONE);
    expect(again).toEqual({ ...first, created: false });
    const stored = await rows('contact_registry');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ pseudonym: DOMAIN, phone: OTHER_PHONE, channel: 'SMS' });
    // The moment of the first registration stays: a repeat is not a new registration.
    expect(stored[0]?.['registered_at']).toEqual(first.registeredAt);
  });

  it('M4-05 FR-19 the same registration at the same time leaves one contact and no error', async () => {
    const results = await Promise.all([register(), register(), register(), register()]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await rows('contact_registry')).toHaveLength(1);
  });

  it('M4-05 FR-19 the contact is keyed by the domain token and holds no other identity', async () => {
    await register();
    const [row] = await rows('contact_registry');
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'channel',
      'phone',
      'pseudonym',
      'registered_at',
    ]);
  });
});

describe('M4-05 FR-08 FR-20 TF-02 send', () => {
  it('M4-05 FR-08 TF-02 the notification token is resolved, the contact found, the SMS sent and one row written without the text', async () => {
    await register();
    const result = await send();
    expect(result).toEqual({ status: 'SENT' });
    expect(resolved).toEqual([NOTIF_TOKEN]);
    expect(sent).toEqual([{ to: PHONE, text: 'Transaksi Rp35000 berhasil.' }]);
    const [row] = await rows('notification_log');
    expect(row).toMatchObject({
      sender_pseudonym: NOTIF_TOKEN,
      recipient_pseudonym: DOMAIN,
      template: 'TX_COMPLETED',
      channel: 'SMS',
      status: 'SENT',
    });
    expect(row?.['sent_at']).toEqual(clock.now());
    const text = JSON.stringify(await rows('notification_log'));
    for (const value of [PHONE, 'Transaksi', '35000']) expect(text).not.toContain(value);
  });

  it.each([
    ['TX_COMPLETED', 'Transaksi Rp8000000 berhasil.'],
    ['TX_HELD_VERIFY', 'Transaksi Rp8000000 sedang diverifikasi.'],
    ['TX_REJECTED', 'Transaksi Rp8000000 ditolak.'],
  ] as const)(
    'M4-05 K-21 the template %s is the fixed text with the amount only',
    async (template, text) => {
      await register();
      await send({ template, amount: 8_000_000 });
      expect(sent).toEqual([{ to: PHONE, text }]);
    },
  );

  it('M4-05 FR-20 Privacy that refuses or is away is FAILED: nothing is sent and no row says who it was for', async () => {
    await register();
    privacyFails = true;
    expect(await send()).toEqual({ status: 'FAILED' });
    expect(sent).toEqual([]);
    expect(await rows('notification_log')).toHaveLength(0);
  });

  it('M4-05 FR-20 a domain without a contact is FAILED: nothing is sent and one FAILED row is written', async () => {
    expect(await send()).toEqual({ status: 'FAILED' });
    expect(sent).toEqual([]);
    const [row] = await rows('notification_log');
    expect(row).toMatchObject({ recipient_pseudonym: DOMAIN, status: 'FAILED' });
  });

  it('M4-05 FR-20 TF-02 an SMS gateway that fails is FAILED with one FAILED row, and the SMS is tried once, never again', async () => {
    await register();
    smsFails = true;
    expect(await send()).toEqual({ status: 'FAILED' });
    expect(sent).toHaveLength(1);
    expect(await rows('notification_log')).toHaveLength(1);
    expect((await rows('notification_log'))[0]).toMatchObject({ status: 'FAILED' });
  });

  it('M4-05 FR-20 a send that is asked twice sends twice and is not deduplicated: sending is not idempotent', async () => {
    await register();
    await send();
    await send();
    expect(sent).toHaveLength(2);
    expect(await rows('notification_log')).toHaveLength(2);
  });

  it('M4-05 FR-20 after the contact was updated the new phone receives the message', async () => {
    await register();
    await register(OTHER_PHONE);
    await send();
    expect(sent.map((message) => message.to)).toEqual([OTHER_PHONE]);
  });
});
