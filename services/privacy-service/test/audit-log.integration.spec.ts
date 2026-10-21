import { join } from 'node:path';
import { DomainError, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditLogService, AuditReader, AuditWriter, AuditedOperation } from '../src/audit';

// Seam: AuditLogService (list, timeline, summary of the audit log) on the real privacy database. The log is read
// through the pool of privpay_auditor, the reads are audited through the pool of privpay_app, as in production.
// Rows are inserted by the schema owner with chosen times. Every value is invented. Needs PostgreSQL and
// scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

const AUDITOR = {
  requestingService: 'ADMIN_CONSOLE',
  actorId: 'usr-auditor',
  actorRole: 'auditor',
};
const ADMIN = { requestingService: 'ADMIN_CONSOLE', actorId: 'usr-admin', actorRole: 'admin' };
const T0 = Date.parse('2026-10-20T08:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

let db: TestDb;
let service: AuditLogService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm303' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  service = new AuditLogService({
    operation: new AuditedOperation(db.app, new AuditWriter()),
    reader: new AuditReader(db.auditor),
  });
});
afterEach(async () => {
  await db.close();
});

interface Seed {
  action?: string;
  status?: string;
  reason?: string;
  service?: string;
  pseudonym?: string | null;
  transactionId?: string | null;
  disclosureId?: string | null;
  attributeNames?: string[] | null;
  when?: Date;
}
async function seed(over: Seed = {}): Promise<void> {
  await db.owner.query(
    `INSERT INTO audit_log (created_at, action, status, reason, requesting_service, pseudonym, transaction_id,
                            disclosure_id, attribute_names)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[])`,
    [
      over.when ?? at(0),
      over.action ?? 'GENERATE_TOKEN',
      over.status ?? 'SUCCESS',
      over.reason ?? 'OK',
      over.service ?? 'API_GATEWAY',
      over.pseudonym ?? null,
      over.transactionId ?? null,
      over.disclosureId ?? null,
      over.attributeNames ?? null,
    ],
  );
}
const views = async () =>
  (
    await db.owner.query<Record<string, unknown>>(
      "SELECT * FROM audit_log WHERE action = 'VIEW_AUDIT_LOG' ORDER BY created_at, id",
    )
  ).rows;
const count = async (): Promise<number> =>
  Number((await db.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0]?.n);

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}
/** A mapping and a disclosure request, only so an audit row can name a disclosure id (foreign keys). */
async function seedDisclosure(): Promise<string> {
  const mapping = await db.owner.query<{ id: string }>(
    `INSERT INTO pseudonym_mapping (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
     VALUES ('CUSTOMER', '\\x01', '\\x02', 'PSEU-0000000A', 'RECONCILIATION', 'INTERNAL_AUDIT', now() + interval '1 day')
     RETURNING id`,
  );
  const request = await db.owner.query<{ id: string }>(
    `INSERT INTO disclosure_request (mapping_id, basis, case_ref, requested_attrs, requester_id)
     VALUES ($1, 'DISPUTE', 'KASUS-1', ARRAY['nama'], 'usr-auditor') RETURNING id`,
    [mapping.rows[0]?.id],
  );
  return request.rows[0]?.id ?? '';
}

describe('M3-03 FR-14 S-55 GET /audit-log: filters (spec privacy 4.8)', () => {
  it('M3-03 FR-14 each filter narrows the result alone, and together they all apply', async () => {
    const disclosure = await seedDisclosure();
    await seed({ service: 'TRANSACTION', pseudonym: 'PSEU-00000001', transactionId: 'TX-1' });
    await seed({
      service: 'RECONCILIATION',
      status: 'DENIED',
      reason: 'EXPIRED',
      action: 'DE_PSEUDONYMIZE',
      pseudonym: 'PSEU-00000002',
      transactionId: 'TX-2',
      disclosureId: disclosure,
      attributeNames: ['nama'],
      when: at(100),
    });
    await seed({
      service: 'RECONCILIATION',
      status: 'DENIED',
      reason: 'TOKEN_NOT_FOUND',
      when: at(200),
    });
    const ids = async (filter: object) =>
      (await service.list(AUDITOR, filter)).items.filter((row) => row.action !== 'VIEW_AUDIT_LOG')
        .length;
    expect(await ids({ service: 'RECONCILIATION' })).toBe(2);
    expect(await ids({ status: 'DENIED' })).toBe(2);
    expect(await ids({ reason: 'EXPIRED' })).toBe(1);
    expect(await ids({ pseudonym: 'PSEU-00000002' })).toBe(1);
    expect(await ids({ transactionId: 'TX-1' })).toBe(1);
    expect(await ids({ action: 'DE_PSEUDONYMIZE' })).toBe(1);
    expect(await ids({ disclosureId: disclosure })).toBe(1);
    expect(await ids({ from: at(100) })).toBeGreaterThanOrEqual(2);
    expect(await ids({ from: at(100), to: at(200) })).toBe(1); // from inclusive, to exclusive
    expect(await ids({ service: 'RECONCILIATION', status: 'DENIED', reason: 'EXPIRED' })).toBe(1);
    expect(await ids({ service: 'TRANSACTION', status: 'DENIED' })).toBe(0);
  });

  it('M3-03 FR-14 attribute_names are names, never values, and the disclosure id is carried', async () => {
    const disclosure = await seedDisclosure();
    await seed({
      action: 'DE_PSEUDONYMIZE',
      attributeNames: ['nik', 'nama'],
      disclosureId: disclosure,
    });
    const { items } = await service.list(AUDITOR, { action: 'DE_PSEUDONYMIZE' });
    expect(items).toHaveLength(1);
    expect(items[0]?.attributeNames).toEqual(['nik', 'nama']);
    expect(items[0]?.disclosureId).toBe(disclosure);
  });

  it('M3-03 S-55 a limit above 200 is a 422, 200 is fine, and so is 1', async () => {
    expect(await reasonOf(service.list(AUDITOR, { limit: 201 }))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(service.list(AUDITOR, { limit: 0 }))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(service.list(AUDITOR, { limit: 1.5 }))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(service.list(AUDITOR, { limit: 200 }))).toBe('no error');
    expect(await reasonOf(service.list(AUDITOR, { limit: 1 }))).toBe('no error');
  });

  it('M3-03 S-55 a limit that is refused is not a read and writes no row', async () => {
    await service.list(AUDITOR, { limit: 201 }).catch(() => undefined);
    expect(await count()).toBe(0);
  });
});

describe('M3-03 FR-14 pagination by an opaque cursor', () => {
  it('M3-03 FR-14 the default page is 50, newest first, and the cursor reaches the rest without gaps or repeats', async () => {
    for (let i = 0; i < 60; i += 1) await seed({ reason: 'OK', when: at(i), pseudonym: null });
    const first = await service.list(AUDITOR, { action: 'GENERATE_TOKEN' });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(AUDITOR, {
      action: 'GENERATE_TOKEN',
      cursor: first.nextCursor as string,
    });
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((row) => row.id)).size).toBe(60);
    const times = all.map((row) => row.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('M3-03 FR-14 rows with the same instant are not lost between pages (id breaks the tie)', async () => {
    for (let i = 0; i < 5; i += 1) await seed({ when: at(0) });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await service.list(AUDITOR, {
        action: 'GENERATE_TOKEN',
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...result.items.map((row) => row.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it.each(['not-a-cursor', '', 'e30', Buffer.from('{"t":"x","i":"y"}').toString('base64url')])(
    'M3-03 FR-14 a cursor that is not ours (%j) is a 422',
    async (cursor) => {
      expect(await reasonOf(service.list(AUDITOR, { cursor }))).toBe('VALIDATION_ERROR');
    },
  );
});

describe('M3-03 US-13 every read is audited, and who may read (AZ-13, AZ-14, AZ-15)', () => {
  it('M3-03 US-13 a list writes one VIEW_AUDIT_LOG row by the reader, and does not see its own row', async () => {
    await seed();
    const first = await service.list(AUDITOR, {});
    expect(first.items.map((row) => row.action)).toEqual(['GENERATE_TOKEN']);
    expect(await views()).toHaveLength(1);
    expect((await views())[0]).toMatchObject({
      status: 'SUCCESS',
      reason: 'OK',
      requesting_service: 'ADMIN_CONSOLE',
      actor_id: 'usr-auditor',
    });
    const second = await service.list(ADMIN, {});
    expect(second.items.map((row) => row.action).sort()).toEqual([
      'GENERATE_TOKEN',
      'VIEW_AUDIT_LOG',
    ]);
    expect(await views()).toHaveLength(2);
  });

  it('M3-03 US-13 timeline and summary are audited too', async () => {
    await service.timeline(AUDITOR, 'PSEU-00000001', {});
    await service.summary(AUDITOR, {});
    expect(await views()).toHaveLength(2);
  });

  it.each([
    ['list', (caller: object) => service.list(caller as never, {})],
    ['timeline', (caller: object) => service.timeline(caller as never, 'PSEU-00000001', {})],
    ['summary', (caller: object) => service.summary(caller as never, {})],
  ])(
    'M3-03 AZ-13 AZ-14 AZ-15 N2 %s: a service is POLICY_NOT_ALLOWED, a fraud analyst FORBIDDEN_ROLE, one DENIED row each',
    async (_name, call) => {
      await seed();
      expect(
        await reasonOf(
          call({
            requestingService: 'RECONCILIATION',
            actorId: 'usr-auditor',
            actorRole: 'auditor',
          }),
        ),
      ).toBe('POLICY_NOT_ALLOWED');
      expect(await reasonOf(call({ ...AUDITOR, actorRole: 'fraud_analyst' }))).toBe(
        'FORBIDDEN_ROLE',
      );
      expect(await reasonOf(call({ ...AUDITOR, actorRole: undefined }))).toBe('FORBIDDEN_ROLE');
      const rows = await views();
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row['status'] === 'DENIED')).toBe(true);
      expect(rows.map((row) => row['reason'])).toEqual(
        expect.arrayContaining(['POLICY_NOT_ALLOWED', 'FORBIDDEN_ROLE']),
      );
    },
  );

  it('M3-03 AZ-13 the admin may list; AZ-14 AZ-15 the admin may not read a timeline or a summary', async () => {
    expect(await reasonOf(service.list(ADMIN, {}))).toBe('no error');
    expect(await reasonOf(service.timeline(ADMIN, 'PSEU-00000001', {}))).toBe('FORBIDDEN_ROLE');
    expect(await reasonOf(service.summary(ADMIN, {}))).toBe('FORBIDDEN_ROLE');
  });

  it('M3-03 a malformed pseudonym or range is a 422 and is not audited (spec privacy 9.4)', async () => {
    expect(await reasonOf(service.timeline(AUDITOR, 'nope', {}))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(service.summary(AUDITOR, { from: new Date('x') }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(await count()).toBe(0);
  });
});

describe('M3-03 US-08 timeline of one token', () => {
  it('M3-03 US-08 rows of that pseudonym only, oldest first', async () => {
    await seed({ pseudonym: 'PSEU-00000001', action: 'RE_ISSUE', when: at(30) });
    await seed({ pseudonym: 'PSEU-00000001', action: 'GENERATE_TOKEN', when: at(10) });
    await seed({ pseudonym: 'PSEU-00000002', when: at(20) });
    await seed({ pseudonym: 'PSEU-00000001', action: 'REVOKE_TOKEN', when: at(50) });
    const { items, nextCursor } = await service.timeline(AUDITOR, 'PSEU-00000001', {});
    expect(items.map((row) => row.action)).toEqual(['GENERATE_TOKEN', 'RE_ISSUE', 'REVOKE_TOKEN']);
    expect(nextCursor).toBeNull();
  });

  it('M3-03 US-08 pages forward with the cursor', async () => {
    for (let i = 0; i < 5; i += 1) await seed({ pseudonym: 'PSEU-00000001', when: at(i) });
    const first = await service.timeline(AUDITOR, 'PSEU-00000001', { limit: 3 });
    const second = await service.timeline(AUDITOR, 'PSEU-00000001', {
      limit: 3,
      cursor: first.nextCursor as string,
    });
    // The first read left its own VIEW_AUDIT_LOG row for this pseudonym, which the second page shows last.
    expect(first.items).toHaveLength(3);
    expect(second.items.map((row) => row.action)).toEqual([
      'GENERATE_TOKEN',
      'GENERATE_TOKEN',
      'VIEW_AUDIT_LOG',
    ]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(6);
  });
});

describe('M3-03 summary: totals, denied by reason, and the simple alert (spec privacy 4.8)', () => {
  const denied = (reason: string, seconds: number, serviceName = 'FRAUD') =>
    seed({ status: 'DENIED', reason, service: serviceName, when: at(seconds) });

  it('M3-03 US-07 counts the total and the DENIED rows by reason, most frequent first', async () => {
    await seed();
    await denied('EXPIRED', 1);
    await denied('SERVICE_MISMATCH', 2);
    await denied('SERVICE_MISMATCH', 3);
    const result = await service.summary(AUDITOR, {});
    expect(result.total).toBe(4);
    expect(result.denied).toEqual([
      { reason: 'SERVICE_MISMATCH', count: 2 },
      { reason: 'EXPIRED', count: 1 },
    ]);
    expect(result.alerts).toEqual([]);
  });

  it('M3-03 US-13 three DENIED SERVICE_MISMATCH from one service within five minutes is an alert', async () => {
    await denied('SERVICE_MISMATCH', 0);
    await denied('SERVICE_MISMATCH', 120);
    await denied('SERVICE_MISMATCH', 300);
    const { alerts } = await service.summary(AUDITOR, {});
    expect(alerts).toEqual([
      {
        requestingService: 'FRAUD',
        reason: 'SERVICE_MISMATCH',
        count: 3,
        windowStart: at(0),
      },
    ]);
  });

  it.each([
    ['two only', [0, 100], 'SERVICE_MISMATCH', 'FRAUD', 'FRAUD'],
    [
      'three but spread over more than five minutes',
      [0, 200, 301],
      'SERVICE_MISMATCH',
      'FRAUD',
      'FRAUD',
    ],
    [
      'three from three different services',
      [0, 10, 20],
      'SERVICE_MISMATCH',
      'FRAUD',
      'NOTIFICATION',
    ],
    ['three of a reason that is not watched', [0, 10, 20], 'EXPIRED', 'FRAUD', 'FRAUD'],
  ])('M3-03 US-13 no alert for %s', async (_name, seconds, reason, first, second) => {
    for (const [index, when] of seconds.entries()) {
      await denied(reason, when, index === 0 ? first : index === 1 ? second : 'TRANSACTION');
    }
    expect((await service.summary(AUDITOR, {})).alerts).toEqual([]);
  });

  it('M3-03 US-13 TOKEN_NOT_FOUND is watched too, and from/to limit what is counted', async () => {
    await denied('TOKEN_NOT_FOUND', 0, 'NOTIFICATION');
    await denied('TOKEN_NOT_FOUND', 10, 'NOTIFICATION');
    await denied('TOKEN_NOT_FOUND', 20, 'NOTIFICATION');
    expect((await service.summary(AUDITOR, {})).alerts).toHaveLength(1);
    const narrowed = await service.summary(AUDITOR, { from: at(5), to: at(1000) });
    expect(narrowed.total).toBe(2);
    expect(narrowed.alerts).toEqual([]);
  });
});
