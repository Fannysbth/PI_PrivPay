import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { compareSchemas } from '../../../tests/baseline/schema-parity';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { baselineContactRepository } from '../src/baseline';
import { proposedContactRepository } from '../src/proposed';

// Seam: the baseline notification-db and its repository, as the real runtime role (ADR-0006, M5-01). The contact is
// keyed by customer_id; the phone is personal data in both modes (D-08), so the control looks for the customer_id.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const person = buildCanary(53);
const AT = new Date('2026-10-23T02:00:00.000Z');

let db: TestDb;
let other: TestDb | undefined;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'notification', suffix: 'm501b' });
  await migrate(db.owner, { root: migrations, mode: 'baseline' });
});
afterEach(async () => {
  await db.close();
  await other?.close();
  other = undefined;
});

describe('M5-01 FR-23 the baseline notification schema keys the contact by customer_id', () => {
  it('M5-01 FR-23 the contact and the log hold customer_id columns and no pseudonym column', async () => {
    const found = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const names = found.rows.map((row) => row.column_name);
    expect(names).toEqual(
      expect.arrayContaining(['customer_id', 'sender_customer_id', 'recipient_customer_id']),
    );
    expect(names.filter((name) => name.includes('pseudonym'))).toEqual([]);
  });

  it('M5-01 FR-23 apart from the identity columns the schema and the grants are those of proposed', async () => {
    other = await createTestDb(config, { service: 'notification', suffix: 'm501p' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    const report = await compareSchemas(
      other.owner,
      db.owner,
      {
        'contact_registry.pseudonym': 'contact_registry.customer_id',
        'notification_log.sender_pseudonym': 'notification_log.sender_customer_id',
        'notification_log.recipient_pseudonym': 'notification_log.recipient_customer_id',
      },
      { proposed: 'privpay_notification_app', baseline: 'privpay_notification_app' },
    );
    expect(report).toEqual({ missing: [], different: [], grants: [] });
  });

  it('M5-01 NFR-09 a contact is never deleted and the log cannot be read back by the application', async () => {
    await expect(db.app.query('DELETE FROM contact_registry')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(db.app.query('SELECT * FROM notification_log')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('M5-01 FR-23 the baseline contact repository is the same domain over the other columns', () => {
  it('M5-01 FR-23 a registration is an upsert: created once, then the phone changes and the first moment stays', async () => {
    const contacts = baselineContactRepository('baseline', db.app);
    const first = await contacts.upsert(person.customer_id, '081200000051', 'SMS', AT);
    expect(first).toEqual({ created: true, registeredAt: AT });
    const later = new Date('2026-10-23T03:00:00.000Z');
    const again = await contacts.upsert(person.customer_id, '081200000052', 'SMS', later);
    expect(again).toEqual({ created: false, registeredAt: AT });
    expect(await contacts.phoneOf(person.customer_id)).toBe('081200000052');
    expect(await contacts.phoneOf('CUST-000102')).toBeUndefined();
  });

  it('M5-01 FR-23 the log keeps who sent and who received, as identities, and no text of the message', async () => {
    await baselineContactRepository('baseline', db.app).log({
      sender: person.customer_id,
      recipient: person.customer_id,
      template: 'TX_COMPLETED',
      channel: 'SMS',
      status: 'SENT',
      sentAt: AT,
    });
    const rows = await db.owner.query(
      'SELECT sender_customer_id, recipient_customer_id, template FROM notification_log',
    );
    expect(rows.rows).toEqual([
      {
        sender_customer_id: person.customer_id,
        recipient_customer_id: person.customer_id,
        template: 'TX_COMPLETED',
      },
    ]);
  });

  it('M5-01 ADR-0006 refuses to be built in the proposed mode', () => {
    expect(() => baselineContactRepository('proposed', db.app)).toThrow(/PRIVACY_MODE=baseline/);
  });
});

describe('M5-01 NFR-15 the positive control: in baseline the scanner finds the customer_id', () => {
  it('M5-01 NFR-15 FR-23 the canary customer_id is found in the dump, and not in proposed', async () => {
    await baselineContactRepository('baseline', db.app).upsert(
      person.customer_id,
      person.hp,
      'SMS',
      AT,
    );
    const found = await scanDatabase(db.owner, [person], 'notification');
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'customer_id',
          location: 'contact_registry.customer_id',
        }),
      ]),
    );

    other = await createTestDb(config, { service: 'notification', suffix: 'm501q' });
    await migrate(other.owner, { root: migrations, mode: 'proposed' });
    await proposedContactRepository(other.app).upsert('PSEU-D0A1B2C3', person.hp, 'SMS', AT);
    const proposed = await scanDatabase(other.owner, [person], 'notification');
    expect(proposed.filter((finding) => finding.attribute === 'customer_id')).toEqual([]);
    // The phone is the one personal value Notification keeps in both modes (D-08).
    expect(proposed.map((finding) => finding.attribute)).toEqual(['hp']);
  });
});
