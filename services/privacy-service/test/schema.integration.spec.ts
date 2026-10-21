import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema, readMigrations } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';

// Seam: the migration files of the privacy database, applied by the schema owner through the shared runner and then
// used only through the real runtime roles (privpay_app, privpay_auditor). Needs PostgreSQL and
// scripts/db/bootstrap.ps1; see scripts/db/README.md. Every value below is invented.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm201' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
});
afterEach(async () => {
  await db.close();
});

/** The SQLSTATE of the rejection (`pg` puts it in `code`), or 'no error'. */
async function sqlState(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
  return 'no error';
}

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const bytes = (n: number, fill = 7): Buffer => Buffer.alloc(n, fill);

/** A valid mapping row; the callers override what the case is about. */
async function insertMapping(
  overrides: Partial<{
    pseudonym: string;
    lookup: Buffer | null;
    enc: Buffer | null;
    status: string;
    purgedAt: string | null;
    service: string;
    purpose: string;
  }> = {},
): Promise<string> {
  const o = {
    pseudonym: 'PSEU-00000001',
    lookup: bytes(32, 1) as Buffer | null,
    enc: bytes(40, 2) as Buffer | null,
    status: 'active',
    purgedAt: null as string | null,
    service: 'TRANSACTION',
    purpose: 'PAYMENT',
    ...overrides,
  };
  const { rows } = await db.app.query<{ id: string }>(
    `INSERT INTO pseudonym_mapping
       (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at, status, purged_at)
     VALUES ('CUSTOMER', $1, $2, $3, $4, $5, now() + interval '1 hour', $6::token_status_enum, $7)
     RETURNING id`,
    [o.enc, o.lookup, o.pseudonym, o.service, o.purpose, o.status, o.purgedAt],
  );
  return rows[0]?.id ?? '';
}

const insertAudit = (): Promise<unknown> =>
  db.app.query(
    `INSERT INTO audit_log (action, status, reason, requesting_service)
     VALUES ('TOKEN_ISSUE', 'SUCCESS', 'OK', 'TRANSACTION')`,
  );

describe('M2-01 FR-15 the final privacy schema', () => {
  it('M2-01 FR-15 creates the five tables of PRD 11, the K-28 link and the migration record', async () => {
    const { rows } = await db.owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'audit_log',
      'disclosure_request',
      'identity_vault',
      'pseudonym_mapping',
      'schema_migrations',
      'transaction_link',
      'transaction_status',
    ]);
  });

  it('M2-01 FR-15 audit_log has disclosure_id and attribute_names and no column that could hold a subject', async () => {
    const { rows } = await db.owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'",
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toEqual(expect.arrayContaining(['disclosure_id', 'attribute_names']));
    expect(columns.filter((c) => /subject|customer|nik|nama|account|rekening/.test(c))).toEqual([]);
  });

  it('M2-01 the migrations of mode baseline are empty: Privacy is not run in that mode (spec data 2)', () => {
    expect(readMigrations(migrations, 'baseline')).toEqual([]);
    expect(readMigrations(migrations, 'proposed').length).toBeGreaterThan(0);
  });

  it('M2-01 running the migrations again changes nothing', async () => {
    const again = await migrate(db.owner, { root: migrations, mode: 'proposed' });
    expect(again.applied).toEqual([]);
  });
});

describe('M2-01 TK-10 the application role cannot rewrite or read the audit log', () => {
  it('M2-01 TK-10 privpay_app can INSERT into audit_log', async () => {
    expect(await sqlState(insertAudit())).toBe('no error');
  });

  it.each([
    ['UPDATE', "UPDATE audit_log SET reason = 'X'"],
    ['DELETE', 'DELETE FROM audit_log'],
    ['TRUNCATE', 'TRUNCATE audit_log'],
    ['SELECT', 'SELECT count(*) FROM audit_log'],
  ])('M2-01 TK-10 privpay_app cannot %s audit_log', async (_verb, statement) => {
    await insertAudit();
    expect(await sqlState(db.app.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it.each([
    'pseudonym_mapping',
    'transaction_status',
    'identity_vault',
    'disclosure_request',
    'audit_log',
  ])(
    'M2-01 TK-10 privpay_app has no DELETE on %s (physical deletion is out of scope)',
    async (table) => {
      // The table name is a constant of this test, not input.
      expect(await sqlState(db.app.query(`DELETE FROM ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
    },
  );

  it('M2-01 NFR-09 privpay_app cannot change the schema', async () => {
    expect(await sqlState(db.app.query('CREATE TABLE evil (id int)'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(db.app.query('ALTER TABLE audit_log ADD COLUMN x int'))).not.toBe(
      'no error',
    );
    expect(await sqlState(db.app.query('DROP TABLE audit_log'))).not.toBe('no error');
  });
});

describe('M2-01 S-34 S-35 the auditor reads the audit log and nothing else', () => {
  it('M2-01 S-34 privpay_auditor can SELECT audit_log', async () => {
    await insertAudit();
    const { rows } = await auditor().query<{ n: string }>('SELECT count(*) AS n FROM audit_log');
    expect(rows[0]?.n).toBe('1');
  });

  it.each([
    [
      'INSERT',
      "INSERT INTO audit_log (action, status, reason, requesting_service) VALUES ('A','SUCCESS','OK','X')",
    ],
    ['UPDATE', "UPDATE audit_log SET reason = 'X'"],
    ['DELETE', 'DELETE FROM audit_log'],
    ['TRUNCATE', 'TRUNCATE audit_log'],
  ])('M2-01 S-34 privpay_auditor cannot %s audit_log', async (_verb, statement) => {
    expect(await sqlState(auditor().query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it.each(['identity_vault', 'pseudonym_mapping', 'disclosure_request', 'transaction_status'])(
    'M2-01 S-35 privpay_auditor cannot read %s',
    async (table) => {
      expect(await sqlState(auditor().query(`SELECT * FROM ${table}`))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    },
  );
});

describe('M2-01 S-22 the database itself rejects half-purged and self-approved rows', () => {
  it('M2-01 S-22 chk_purged rejects purged_at while the lookup or the ciphertext is still there', async () => {
    const now = new Date().toISOString();
    for (const half of [
      { lookup: bytes(32), enc: null },
      { lookup: null, enc: bytes(40) },
      { lookup: bytes(32), enc: bytes(40) },
    ]) {
      expect(await sqlState(insertMapping({ ...half, purgedAt: now }))).toBe(CHECK_VIOLATION);
    }
    expect(await sqlState(insertMapping({ lookup: null, enc: null, purgedAt: now }))).toBe(
      'no error',
    );
  });

  it('M2-01 S-22 chk_purged rejects an UPDATE that sets only purged_at', async () => {
    const id = await insertMapping();
    expect(
      await sqlState(
        db.app.query('UPDATE pseudonym_mapping SET purged_at = now() WHERE id = $1', [id]),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it.each(['customer_lookup', 'customer_id_enc', 'nik_enc', 'nama_enc', 'hp_enc', 'rekening_enc'])(
    'M2-01 S-22 chk_vault_purged rejects a purged vault row that still holds %s',
    async (column) => {
      // The column name is a constant of this test, not input.
      const insert = (value: Buffer | null): Promise<unknown> =>
        db.app.query(`INSERT INTO identity_vault (${column}, purged_at) VALUES ($1, now())`, [
          value,
        ]);
      expect(await sqlState(insert(bytes(40)))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insert(null))).toBe('no error');
    },
  );

  it('M2-01 S-22 chk_four_eyes rejects an approver equal to the requester, even written directly', async () => {
    const mapping = await insertMapping();
    const insert = (requester: string, approver: string | null): Promise<unknown> =>
      db.app.query(
        `INSERT INTO disclosure_request (mapping_id, basis, case_ref, requested_attrs, requester_id, approver_id)
         VALUES ($1, 'COURT_ORDER', 'CASE-TEST-1', ARRAY['nik']::text[], $2, $3)`,
        [mapping, requester, approver],
      );
    expect(await sqlState(insert('auditor-a', 'auditor-a'))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert('auditor-a', 'auditor-b'))).toBe('no error');
    expect(await sqlState(insert('auditor-a', null))).toBe('no error');
  });

  it('M2-01 S-22 chk_attribute_names allows only customer_id, nik and nama and refuses free text', async () => {
    const insert = (names: string[] | null): Promise<unknown> =>
      db.app.query(
        `INSERT INTO audit_log (action, status, reason, requesting_service, attribute_names)
         VALUES ('DISCLOSE', 'SUCCESS', 'OK', 'PRIVACY', $1::text[])`,
        [names],
      );
    expect(await sqlState(insert(['customer_id', 'nik', 'nama']))).toBe('no error');
    expect(await sqlState(insert(null))).toBe('no error');
    expect(await sqlState(insert(['hp']))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert(['nik', 'a value typed by someone']))).toBe(CHECK_VIOLATION);
  });
});

describe('M2-01 FR-15 FR-25 every index of PRD 11 exists', () => {
  it('M2-01 FR-15 FR-25 the indexes of the mapping table, the audit log and the K-28 link are all there', async () => {
    const { rows } = await db.owner.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND (indexname LIKE 'idx%' OR indexname = 'uq_mapping_active') ORDER BY 1",
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'idx_audit_denied',
      'idx_audit_pseu',
      'idx_audit_time',
      'idx_link_pseudonym',
      'idx_mapping_expiry',
      'idx_mapping_pseudonym',
      'idx_mapping_purge',
      'idx_mapping_tx',
      'uq_mapping_active',
    ]);
  });
});

describe('M2-01 N-24 the database also refuses incomplete rows that are not purged', () => {
  it('M2-01 N-24 chk_mapping_complete: a mapping that is not purged needs its ciphertext and its lookup', async () => {
    expect(await sqlState(insertMapping({ lookup: null }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insertMapping({ enc: null }))).toBe(CHECK_VIOLATION);
    const id = await insertMapping({ pseudonym: 'PSEU-0000000C' });
    for (const column of ['subject_lookup', 'subject_id_enc']) {
      // The column name is a constant of this test, not input.
      expect(
        await sqlState(
          db.app.query(`UPDATE pseudonym_mapping SET ${column} = NULL WHERE id = $1`, [id]),
        ),
      ).toBe(CHECK_VIOLATION);
    }
  });

  it('M2-01 N-24 chk_mapping_complete: two incomplete rows cannot slip past uq_mapping_active as NULL lookups', async () => {
    const insert = (pseudonym: string): Promise<string> =>
      insertMapping({ pseudonym, lookup: null });
    expect(await sqlState(insert('PSEU-0000000D'))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert('PSEU-0000000E'))).toBe(CHECK_VIOLATION);
  });

  it.each(['customer_lookup', 'customer_id_enc'])(
    'M2-01 N-24 chk_vault_complete: a vault row that is not purged needs %s',
    async (missing) => {
      const values: Record<string, Buffer | null> = {
        customer_lookup: bytes(32, 5),
        customer_id_enc: bytes(40, 6),
        [missing]: null,
      };
      expect(
        await sqlState(
          db.app.query(
            'INSERT INTO identity_vault (customer_lookup, customer_id_enc) VALUES ($1, $2)',
            [values['customer_lookup'], values['customer_id_enc']],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
    },
  );

  describe('chk_disclosure_decided', () => {
    let serial = 0;
    // A fresh mapping per call: the loop below inserts several requests in one test.
    const nextPseudonym = (): string => `PSEU-D${String((serial += 1)).padStart(7, '0')}`;
    const insert = (
      status: string,
      fields: { approver?: string | null; decidedAt?: string | null; expiresAt?: string | null },
    ): Promise<unknown> =>
      insertMapping({ pseudonym: nextPseudonym(), lookup: bytes(32, 100 + serial) }).then(
        (mapping) =>
          db.app.query(
            `INSERT INTO disclosure_request
             (mapping_id, basis, case_ref, requested_attrs, requester_id, approver_id, status, decided_at, expires_at)
           VALUES ($1, 'DISPUTE', 'CASE-TEST-1', ARRAY['nik']::text[], 'auditor-a', $2, $3, $4, $5)`,
            [
              mapping,
              fields.approver ?? null,
              status,
              fields.decidedAt ?? null,
              fields.expiresAt ?? null,
            ],
          ),
      );
    const complete = {
      approver: 'admin-b',
      decidedAt: '2026-10-20T10:00:00Z',
      expiresAt: '2026-10-20T10:10:00Z',
    };

    it.each(['APPROVED', 'USED'])(
      'M2-01 N-24 a %s request needs the approver and the decision time',
      async (status) => {
        expect(await sqlState(insert(status, complete))).toBe('no error');
        for (const missing of ['approver', 'decidedAt'] as const) {
          expect(await sqlState(insert(status, { ...complete, [missing]: null }))).toBe(
            CHECK_VIOLATION,
          );
        }
      },
    );

    it.each(['PENDING', 'REJECTED', 'EXPIRED'])(
      'M2-01 N-24 a %s request needs no approver',
      async (status) => {
        expect(await sqlState(insert(status, {}))).toBe('no error');
      },
    );
  });

  it('M2-01 N-24 chk_requested_attrs: only customer_id, nik and nama can be requested', async () => {
    const mapping = await insertMapping({ pseudonym: 'PSEU-00000010' });
    const insert = (attrs: string[]): Promise<unknown> =>
      db.app.query(
        `INSERT INTO disclosure_request (mapping_id, basis, case_ref, requested_attrs, requester_id)
         VALUES ($1, 'DISPUTE', 'CASE-TEST-1', $2::text[], 'auditor-a')`,
        [mapping, attrs],
      );
    expect(await sqlState(insert(['nik', 'nama']))).toBe('no error');
    expect(await sqlState(insert(['hp']))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert(['rekening', 'nik']))).toBe(CHECK_VIOLATION);
  });
});

describe('M2-01 FR-25 uniqueness and the row identifiers', () => {
  it('M2-01 FR-25 uq_mapping_active allows one active token per lookup, service and purpose', async () => {
    await insertMapping({ pseudonym: 'PSEU-00000001' });
    expect(await sqlState(insertMapping({ pseudonym: 'PSEU-00000002' }))).toBe(UNIQUE_VIOLATION);
    // Another purpose or service is another token; an expired one no longer counts (PRD 11).
    expect(await sqlState(insertMapping({ pseudonym: 'PSEU-00000003', purpose: 'FRAUD' }))).toBe(
      'no error',
    );
    expect(await sqlState(insertMapping({ pseudonym: 'PSEU-00000004', service: 'FRAUD' }))).toBe(
      'no error',
    );
    expect(await sqlState(insertMapping({ pseudonym: 'PSEU-00000005', status: 'expired' }))).toBe(
      'no error',
    );
  });

  it('M2-01 FR-25 the pseudonym and the vault customer_lookup are unique', async () => {
    await insertMapping({ pseudonym: 'PSEU-0000000A', lookup: bytes(32, 3), purpose: 'A' });
    expect(
      await sqlState(
        insertMapping({ pseudonym: 'PSEU-0000000A', lookup: bytes(32, 4), purpose: 'B' }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    const vault = (): Promise<unknown> =>
      db.app.query(
        'INSERT INTO identity_vault (customer_lookup, customer_id_enc) VALUES ($1, $2)',
        [bytes(32, 5), bytes(40, 6)],
      );
    await vault();
    expect(await sqlState(vault())).toBe(UNIQUE_VIOLATION);
  });

  it('M2-01 FR-25 audit_log.mapping_id and disclosure_id must point at existing rows', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      await sqlState(
        db.app.query(
          "INSERT INTO audit_log (action, status, reason, requesting_service, mapping_id) VALUES ('A','SUCCESS','OK','X', $1)",
          [missing],
        ),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await sqlState(
        db.app.query(
          "INSERT INTO audit_log (action, status, reason, requesting_service, disclosure_id) VALUES ('A','SUCCESS','OK','X', $1)",
          [missing],
        ),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('M2-01 NFR-04 the main lookups use an index at 20,000 rows', () => {
  interface Plan {
    'Node Type': string;
    Plans?: Plan[];
  }
  const nodeTypes = (plan: Plan): string[] => [
    plan['Node Type'],
    ...(plan.Plans ?? []).flatMap(nodeTypes),
  ];

  async function explain(sql: string, params: unknown[]): Promise<string[]> {
    const { rows } = await db.app.query<{ 'QUERY PLAN': [{ Plan: Plan }] }>(
      `EXPLAIN (FORMAT JSON) ${sql}`,
      params,
    );
    return nodeTypes(rows[0]?.['QUERY PLAN'][0]?.Plan as Plan);
  }

  beforeEach(async () => {
    // Synthetic rows made by the owner (the application role could do it too; this is faster to read).
    await db.owner.query(
      `INSERT INTO pseudonym_mapping
         (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at, status)
       SELECT 'CUSTOMER', decode(md5(g::text), 'hex'), decode(md5('l' || g::text), 'hex'),
              'PSEU-' || lpad(to_hex(g), 8, '0'),
              (ARRAY['TRANSACTION','FRAUD','NOTIFICATION'])[1 + g % 3], 'PURPOSE-' || (g % 4),
              now() + (g % 1000) * interval '1 minute',
              CASE WHEN g % 5 = 0 THEN 'active'::token_status_enum ELSE 'expired'::token_status_enum END
       FROM generate_series(1, 20000) AS g`,
    );
    await db.owner.query('ANALYZE pseudonym_mapping');
  });

  it('M2-01 NFR-04 the lookup by subject_lookup, service, purpose and status does not scan the table', async () => {
    // g = 5 is active, service index 1 + 5 % 3 = 3 (NOTIFICATION), purpose 5 % 4 = 1.
    const types = await explain(
      `SELECT id FROM pseudonym_mapping
        WHERE subject_lookup = decode(md5('l5'), 'hex') AND service_id = $1 AND purpose = $2 AND status = 'active'`,
      ['NOTIFICATION', 'PURPOSE-1'],
    );
    expect(types).not.toContain('Seq Scan');
  });

  it('M2-01 NFR-04 the lookup by pseudonym does not scan the table', async () => {
    const types = await explain('SELECT id FROM pseudonym_mapping WHERE pseudonym = $1', [
      'PSEU-00000100',
    ]);
    expect(types).not.toContain('Seq Scan');
  });
});

/** The harness hands out the auditor pool for the privacy service; its absence would be a harness bug. */
function auditor(): TestDb['app'] {
  if (db.auditor === undefined) throw new Error('the privacy test database has no auditor pool');
  return db.auditor;
}
