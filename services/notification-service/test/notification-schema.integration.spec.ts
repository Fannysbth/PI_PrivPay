import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';

// Seam: the notification-db after its migrations, seen through the real roles. The phone number is the one personal
// value outside Privacy and the IdP (D-08); it is in contact_registry and nowhere else. Needs PostgreSQL and
// scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'notification', suffix: 'm405s' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
});
afterEach(async () => {
  await db.close();
});

const sqlState = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};
const columns = async (table: string): Promise<string[]> =>
  (
    await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )
  ).rows.map((row) => row.column_name);
const contact = (channel = 'SMS') =>
  db.app.query(
    `INSERT INTO contact_registry (pseudonym, phone, channel) VALUES ('PSEU-00000005', '081200000001', $1)`,
    [channel],
  );
const logRow = () =>
  db.app.query(
    `INSERT INTO notification_log (sender_pseudonym, recipient_pseudonym, template, channel, status)
     VALUES ('PSEU-00000004', 'PSEU-00000005', 'TX_COMPLETED', 'SMS', 'SENT')`,
  );

describe('M4-05 FR-19 FR-20 S-38 the schema holds a token, a phone number and a status', () => {
  it('M4-05 FR-19 the tables have exactly the columns of PRD 11: no customer_id, nik, name, e-mail or message text', async () => {
    expect(await columns('contact_registry')).toEqual([
      'pseudonym',
      'phone',
      'channel',
      'registered_at',
    ]);
    expect(await columns('notification_log')).toEqual([
      'id',
      'sender_pseudonym',
      'recipient_pseudonym',
      'template',
      'channel',
      'sent_at',
      'status',
    ]);
  });

  it('M4-05 D-08 the phone is the only personal column of the database, and it is in contact_registry', async () => {
    const found = await db.owner.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
          AND column_name ~* '(customer_id|subject|nik|nama|name|email|rekening|account|message|text|body|phone|hp)'
        ORDER BY table_name, column_name`,
    );
    expect(found.rows).toEqual([{ table_name: 'contact_registry', column_name: 'phone' }]);
  });

  it('M4-05 FR-19 the channel can only be SMS', async () => {
    expect(await sqlState(contact('EMAIL'))).toBe(CHECK_VIOLATION);
    expect(await sqlState(contact('SMS'))).toBeUndefined();
  });
});

describe('M4-05 NFR-09 the runtime role has the least privilege', () => {
  it('M4-05 NFR-09 the contacts can be added, read and updated, never deleted', async () => {
    await contact();
    expect((await db.app.query('SELECT 1 FROM contact_registry')).rowCount).toBe(1);
    expect(
      await sqlState(db.app.query(`UPDATE contact_registry SET phone = '081200000002'`)),
    ).toBeUndefined();
    expect(await sqlState(db.app.query('DELETE FROM contact_registry'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('TRUNCATE contact_registry'))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('M4-05 NFR-09 the log is append-only: rows can be added, never read back, changed or removed', async () => {
    expect(await sqlState(logRow())).toBeUndefined();
    expect(await sqlState(db.app.query('SELECT 1 FROM notification_log'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query(`UPDATE notification_log SET status = 'FAILED'`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('DELETE FROM notification_log'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.app.query('DROP TABLE notification_log'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
