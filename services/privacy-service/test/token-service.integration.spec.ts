import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import type { Pool, PoolClient } from 'pg';
import { AuditReader, AuditWriter, AuditedOperation } from '../src/audit';
import {
  BlindIndex,
  FieldCipher,
  TokenMint,
  createKeys,
  mappingBinding,
  type MintInput,
} from '../src/crypto';
import { PolicyEngine } from '../src/policy';
// (type-only use below: the broken stand-in for the engine)
import { TOKEN_SQL, TokenService, type GenerateRequest } from '../src/token';

// Seam: TokenService.generate on the real privacy database, as the real runtime roles (privpay_app writes,
// privpay_auditor reads the audit back), with a FakeClock. Failures in the middle are real database errors. Needs
// PostgreSQL and scripts/db/bootstrap.ps1. Every value is invented (PRD 16 style).
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

const keys = createKeys({
  token: Buffer.alloc(32, 1),
  index: Buffer.alloc(32, 2),
  field: new Map([[1, Buffer.alloc(32, 3)]]),
  fieldVersion: 1,
});
const index = new BlindIndex(keys);
const cipher = new FieldCipher(keys);
const realMint = new TokenMint(keys);

const TTL = {
  PAYMENT_PROCESSING: 900,
  FRAUD_DETECTION: 2_592_000,
  NOTIFICATION: 900,
  NOTIFICATION_REGISTRATION: 31_536_000,
  DAILY_RECONCILIATION: 86_400,
  INTERNAL_AUDIT: 600,
};
const START = '2026-10-20T08:00:00.000Z';
const CUSTOMER = 'CUST-000101';

let db: TestDb;
let clock: FakeClock;
let reader: AuditReader;
let mint: { mint(input: MintInput): string };
let service: TokenService;

function build(): TokenService {
  return new TokenService({
    operation: new AuditedOperation(db.app, new AuditWriter()),
    policy: new PolicyEngine(TTL),
    index,
    cipher,
    mint,
    clock,
    graceSeconds: 30,
    keyVersion: 1,
  });
}

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm205' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  reader = new AuditReader(db.auditor);
  clock = new FakeClock(START);
  mint = realMint;
  service = build();
});
afterEach(async () => {
  await db.close();
});

const p1 = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  requestingService: 'API_GATEWAY',
  subjectType: 'CUSTOMER',
  subjectId: CUSTOMER,
  targetService: 'TRANSACTION',
  purpose: 'PAYMENT_PROCESSING',
  ...over,
});

/** Records the text of every statement a pool's clients run, so a test can count the round trips of one operation. */
function recording(pool: Pool, statements: string[]): Pool {
  const bound = (target: object, name: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, name, target);
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(target)
      : value;
  };
  return new Proxy(pool, {
    get(target, name) {
      if (name !== 'connect') return bound(target, name);
      return async (): Promise<PoolClient> => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, member) {
            if (member !== 'query') return bound(inner, member);
            return (...args: unknown[]): unknown => {
              const first = args[0];
              statements.push(typeof first === 'string' ? first : '');
              return (inner.query as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      };
    },
  });
}

const count = async (table: string): Promise<number> => {
  // The table name is a constant of this test.
  const { rows } = await db.owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
};
const mappings = async (): Promise<Record<string, unknown>[]> =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM pseudonym_mapping ORDER BY created_at, pseudonym',
    )
  ).rows;

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}

describe('PERF-01 round trips of one token operation (NFR-02, NFR-04)', () => {
  it('PERF-01 reusing an active token takes five statements: BEGIN, lock, expire-and-find, one audit row, COMMIT', async () => {
    const statements: string[] = [];
    const counted = new TokenService({
      operation: new AuditedOperation(recording(db.app, statements), new AuditWriter()),
      policy: new PolicyEngine(TTL),
      index,
      cipher,
      mint,
      clock,
      graceSeconds: 30,
      keyVersion: 1,
    });
    const first = await counted.generate(p1());
    statements.length = 0;

    const again = await counted.generate(p1());

    expect(again.reused).toBe(true);
    expect(again.pseudonym).toBe(first.pseudonym);
    expect(statements).toHaveLength(5);
    // A statement that stands alone for the expiry is the sixth round trip this test exists to keep away.
    expect(statements.filter((sql) => sql.includes("SET status = 'expired'"))).toHaveLength(1);
    expect(statements.some((sql) => sql.startsWith('INSERT INTO audit_log'))).toBe(true);
  });

  it('PERF-01 an expired token is marked and a new one issued in the same statement count budget plus the insert', async () => {
    const statements: string[] = [];
    const counted = new TokenService({
      operation: new AuditedOperation(recording(db.app, statements), new AuditWriter()),
      policy: new PolicyEngine(TTL),
      index,
      cipher,
      mint,
      clock,
      graceSeconds: 30,
      keyVersion: 1,
    });
    const first = await counted.generate(p1());
    clock.advance(901);
    statements.length = 0;

    const second = await counted.generate(p1());

    expect(second.reused).toBe(false);
    expect(second.pseudonym).not.toBe(first.pseudonym);
    expect(statements).toHaveLength(6);
    const rows = await mappings();
    expect(rows.map((row) => row['status']).sort()).toEqual(['active', 'expired']);
  });
});

describe('M2-05 FR-04 generate from identity (spec privacy 7.2, 7.3)', () => {
  it('M2-05 FR-04 issues a PSEU token with the TTL of the purpose, stores the subject only encrypted, writes one audit row', async () => {
    const result = await service.generate(p1());
    expect(result.pseudonym).toMatch(/^PSEU-[0-9A-F]{8}$/);
    expect(result.reused).toBe(false);
    expect(result.expiresAt.toISOString()).toBe('2026-10-20T08:15:00.000Z');

    const [row] = await mappings();
    expect(row).toMatchObject({
      subject_type: 'CUSTOMER',
      pseudonym: result.pseudonym,
      service_id: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      status: 'active',
      key_version: 1,
      transaction_id: null,
    });
    const id = String(row?.['id']);
    expect(cipher.decrypt(row?.['subject_id_enc'] as Buffer, mappingBinding('CUSTOMER', id))).toBe(
      CUSTOMER,
    );
    expect(row?.['subject_lookup']).toEqual(index.lookup('CUSTOMER', CUSTOMER));
    expect(JSON.stringify(await mappings())).not.toContain(CUSTOMER);

    const audit = await reader.query({});
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'GENERATE_TOKEN',
      status: 'SUCCESS',
      reason: 'OK',
      requestingService: 'API_GATEWAY',
      pseudonym: result.pseudonym,
      purpose: 'PAYMENT_PROCESSING',
      mappingId: id,
      keyVersion: 1,
    });
  });

  it('M2-05 FR-04 the same subject, service and purpose gets the active token back, audited as REUSED_ACTIVE', async () => {
    const first = await service.generate(p1());
    clock.advance(60);
    const second = await service.generate(p1());
    expect(second).toEqual({ ...first, reused: true });
    expect(await count('pseudonym_mapping')).toBe(1);
    const audit = await reader.query({});
    expect(audit.map((r) => r.reason)).toEqual(['REUSED_ACTIVE', 'OK']);
  });

  it('M2-05 FR-04 a different purpose or subject type is a different token', async () => {
    const a = await service.generate(p1());
    const b = await service.generate(p1({ subjectType: 'ACCOUNT', subjectId: '1234567801' }));
    const c = await service.generate(
      p1({ targetService: 'NOTIFICATION', purpose: 'NOTIFICATION_REGISTRATION' }),
    );
    expect(new Set([a.pseudonym, b.pseudonym, c.pseudonym]).size).toBe(3);
    expect(await count('pseudonym_mapping')).toBe(3);
  });

  it('M2-05 FR-04 a transaction id given by the Gateway is stored with the row', async () => {
    await service.generate(p1({ transactionId: 'TX-1700000000001' }));
    expect((await mappings())[0]).toMatchObject({ transaction_id: 'TX-1700000000001' });
    expect((await reader.query({}))[0]).toMatchObject({ transactionId: 'TX-1700000000001' });
  });
});

describe('M2-05 FR-33 T-06 TF-15 a token past its TTL is replaced, one active row at a time', () => {
  it('M2-05 TF-15 issue, move the clock past the TTL, issue again: a new token, the old row expired', async () => {
    const first = await service.generate(p1());
    clock.advance(TTL.PAYMENT_PROCESSING + 1);
    const second = await service.generate(p1());
    expect(second.reused).toBe(false);
    expect(second.pseudonym).not.toBe(first.pseudonym);
    const rows = await mappings();
    expect(rows.map((r) => [r['pseudonym'], r['status']]).sort()).toEqual(
      [
        [first.pseudonym, 'expired'],
        [second.pseudonym, 'active'],
      ].sort(),
    );
  });

  it('M2-05 TF-15 exactly at the expiry the token is still the active one', async () => {
    const first = await service.generate(p1());
    clock.advance(TTL.PAYMENT_PROCESSING);
    expect((await service.generate(p1())).pseudonym).toBe(first.pseudonym);
  });

  it('M2-05 TF-15 without the marking the database itself refuses a second active row (23505 uq_mapping_active)', async () => {
    const insert = (pseudonym: string): Promise<unknown> =>
      db.app.query(
        `INSERT INTO pseudonym_mapping
           (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
         VALUES ('CUSTOMER', $1, $2, $3, 'TRANSACTION', 'PAYMENT_PROCESSING', '2026-10-20T07:00:00Z')`,
        [Buffer.alloc(40, 1), index.lookup('CUSTOMER', CUSTOMER), pseudonym],
      );
    await insert('PSEU-0000000A');
    await expect(insert('PSEU-0000000B')).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_mapping_active',
    });
  });
});

describe('M2-05 NFR-13 C-03 T-05 parallel requests for one combination', () => {
  it('M2-05 TF-07 50 parallel requests, 5 rounds: one reused:false, 49 reused:true, one active row, no error', async () => {
    for (let round = 1; round <= 5; round += 1) {
      const subjectId = `CUST-${String(200 + round).padStart(6, '0')}`;
      const results = await Promise.all(
        Array.from({ length: 50 }, () => service.generate(p1({ subjectId }))),
      );
      expect(results.filter((r) => !r.reused)).toHaveLength(1);
      expect(results.filter((r) => r.reused)).toHaveLength(49);
      expect(new Set(results.map((r) => r.pseudonym)).size).toBe(1);
      const { rows } = await db.owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM pseudonym_mapping WHERE subject_lookup = $1 AND status = 'active'`,
        [index.lookup('CUSTOMER', subjectId)],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    }
    expect(await count('audit_log')).toBe(250);
  });

  it('M2-05 C-04 T-05 guard: the same scenario without the advisory lock is refused by uq_mapping_active', async () => {
    // What buat_token avoids: ten transactions all see "no active token", then all insert. Exactly one can win; the
    // others fail 23505 and, in PostgreSQL, abort. The lock of step 2 is what keeps them in line (ADR-0010).
    const clients: PoolClient[] = await Promise.all(
      Array.from({ length: 10 }, () => db.app.connect()),
    );
    const lookup = index.lookup('CUSTOMER', CUSTOMER);
    try {
      await Promise.all(clients.map((c) => c.query('BEGIN')));
      for (const c of clients) {
        const { rows } = await c.query(
          `SELECT id FROM pseudonym_mapping WHERE subject_lookup = $1 AND service_id = 'TRANSACTION'
             AND purpose = 'PAYMENT_PROCESSING' AND status = 'active'`,
          [lookup],
        );
        expect(rows).toHaveLength(0);
      }
      const insert = (c: PoolClient, i: number): Promise<unknown> =>
        c.query(
          `INSERT INTO pseudonym_mapping
             (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
           VALUES ('CUSTOMER', $1, $2, $3, 'TRANSACTION', 'PAYMENT_PROCESSING', '2027-01-01T00:00:00Z')`,
          [Buffer.alloc(40, 1), lookup, `PSEU-0000010${String(i)}`],
        );
      const [winner, ...others] = clients as [PoolClient, ...PoolClient[]];
      await insert(winner, 0);
      // The other nine must learn whether the first row commits: they wait for it, or meet it already committed.
      // Either way they are refused, and neither order may be waited out with a sleep.
      const waiting = others.map((c, i) => insert(c, i + 1));
      await winner.query('COMMIT');
      const outcomes = await Promise.allSettled(waiting);
      await Promise.allSettled(others.map((c) => c.query('ROLLBACK')));
      expect(outcomes).toHaveLength(9);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({
          code: '23505',
          constraint: 'uq_mapping_active',
        });
      }
    } finally {
      for (const c of clients) c.release();
    }
  });
});

describe('M2-05 C-04 a pseudonym collision is retried from a new nonce (ADR-0010)', () => {
  const COLLIDING = 'PSEU-0000000A';

  async function seedTaken(): Promise<void> {
    const id = randomUUID();
    await db.owner.query(
      `INSERT INTO pseudonym_mapping
         (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
       VALUES ($1, 'CUSTOMER', $2, $3, $4, 'FRAUD', 'FRAUD_DETECTION', '2027-01-01T00:00:00Z')`,
      [
        id,
        cipher.encrypt('CUST-000999', mappingBinding('CUSTOMER', id)),
        index.lookup('CUSTOMER', 'CUST-000999'),
        COLLIDING,
      ],
    );
  }

  it('M2-05 C-04 three collisions in a row, then success on the fourth value, without aborting the transaction', async () => {
    await seedTaken();
    let calls = 0;
    mint = {
      mint: (input) => {
        calls += 1;
        return calls <= 3 ? COLLIDING : realMint.mint(input);
      },
    };
    service = build();
    const result = await service.generate(p1());
    expect(calls).toBe(4);
    expect(result.pseudonym).not.toBe(COLLIDING);
    expect(await count('pseudonym_mapping')).toBe(2);
    expect((await reader.query({}))[0]).toMatchObject({ status: 'SUCCESS', reason: 'OK' });
  });

  it('M2-05 C-04 after 20 collisions the operation fails with INTERNAL_ERROR and leaves nothing behind', async () => {
    await seedTaken();
    let calls = 0;
    mint = {
      mint: () => {
        calls += 1;
        return COLLIDING;
      },
    };
    service = build();
    expect(await reasonOf(service.generate(p1()))).toBe('INTERNAL_ERROR');
    expect(calls).toBe(20);
    expect(await count('pseudonym_mapping')).toBe(1);
    expect(await count('audit_log')).toBe(0);
  });
});

describe('M2-05 FR-13 one audit row per operation, in the transaction of its result', () => {
  it('M2-05 FR-13 a commit the database refuses takes the new token and its audit row down together', async () => {
    await db.owner.query(`
      CREATE FUNCTION refuse_audit_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
      CREATE CONSTRAINT TRIGGER refuse_audit AFTER INSERT ON audit_log
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_audit_at_commit();`);
    expect(await reasonOf(service.generate(p1()))).toBe('INTERNAL_ERROR');
    expect(await count('pseudonym_mapping')).toBe(0);
    expect(await count('audit_log')).toBe(0);
  });

  it('M2-05 FR-13 every call, issued or reused, leaves exactly one audit row', async () => {
    await service.generate(p1());
    await service.generate(p1());
    await service.generate(p1({ subjectId: 'CUST-000102' }));
    expect(await count('audit_log')).toBe(3);
  });
});

describe('M2-05 TK-06 TK-07 TK-14 AZ-18 policy refusals are audited decisions with no mapping row', () => {
  const refused = async (
    request: GenerateRequest,
    reason: string,
    audit: Record<string, unknown>,
  ): Promise<void> => {
    expect(await reasonOf(service.generate(request))).toBe(reason);
    expect(await count('pseudonym_mapping')).toBe(0);
    const rows = await reader.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'GENERATE_TOKEN', status: 'DENIED', reason, ...audit });
  };

  it('M2-05 TK-07 AZ-18 TRANSACTION sending a subject_id is POLICY_NOT_ALLOWED', async () => {
    await refused(p1({ requestingService: 'TRANSACTION' }), 'POLICY_NOT_ALLOWED', {
      requestingService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
    });
  });

  it('M2-05 TK-06 a purpose outside the whitelist is POLICY_NOT_ALLOWED', async () => {
    await refused(p1({ purpose: 'MARKETING' }), 'POLICY_NOT_ALLOWED', { purpose: 'MARKETING' });
  });

  it('M2-05 TK-14 FRAUD asking for a token of an ACCOUNT is POLICY_NOT_ALLOWED', async () => {
    await refused(
      p1({
        requestingService: 'FRAUD',
        subjectType: 'ACCOUNT',
        subjectId: '1234567801',
        targetService: 'FRAUD',
        purpose: 'FRAUD_DETECTION',
      }),
      'POLICY_NOT_ALLOWED',
      { requestingService: 'FRAUD' },
    );
  });

  it('M2-05 FR-04 the Gateway cannot issue P7 from identity, and a service not in Tabel 1 gets nothing', async () => {
    await refused(
      p1({ targetService: 'RECONCILIATION', purpose: 'INTERNAL_AUDIT' }),
      'POLICY_NOT_ALLOWED',
      { purpose: 'INTERNAL_AUDIT' },
    );
  });

  it('M2-05 FR-04 the caller is the one the service was told, whatever else the request carries', async () => {
    // requesting_service has one source only (invariant 7); a field of that name on the request is not read.
    const forged = {
      ...p1({ requestingService: 'TRANSACTION' }),
      requesting_service: 'API_GATEWAY',
    };
    expect(await reasonOf(service.generate(forged))).toBe('POLICY_NOT_ALLOWED');
  });
});

describe('M2-05 a request of the wrong shape is a validation error: refused, not audited, nothing written', () => {
  it.each([
    ['a customer id of the wrong shape', p1({ subjectId: 'CUST-12' })],
    ['an account number with letters', p1({ subjectType: 'ACCOUNT', subjectId: '12AB5678' })],
    ['an empty subject id', p1({ subjectId: '' })],
    ['a very long subject id', p1({ subjectId: `CUST-${'9'.repeat(500)}` })],
    ['an unknown subject type', p1({ subjectType: 'MERCHANT' })],
    ['a transaction id of the wrong shape', p1({ transactionId: 'TX-12 34' })],
    ['a purpose that is not an identifier', p1({ purpose: 'marketing campaign' })],
    ['a target service that is not an identifier', p1({ targetService: 'trans action' })],
    ['a transaction id that is not text', p1({ transactionId: 123 as never })],
    ['an actor id that is not text', p1({ actorId: {} as never })],
    ['a subject type that is not text', p1({ subjectType: 5 as never })],
    ['a requesting service that is not an identifier', p1({ requestingService: 'api gateway' })],
    ['a requesting service that is not text', p1({ requestingService: 7 as never })],
  ])('M2-05 FR-04 %s', async (_name, request) => {
    expect(await reasonOf(service.generate(request))).toBe('VALIDATION_ERROR');
    expect(await count('pseudonym_mapping')).toBe(0);
    expect(await count('audit_log')).toBe(0);
  });
});

describe('M2-05 FR-13 only a decision of the policy is audited as DENIED', () => {
  it('M2-05 FR-13 any other failure of the policy leaves no DENIED row and no mapping row', async () => {
    const broken = {
      evaluate: () => {
        throw new DomainError('SERVICE_UNAVAILABLE');
      },
    } as unknown as PolicyEngine;
    const odd = new TokenService({
      operation: new AuditedOperation(db.app, new AuditWriter()),
      policy: broken,
      index,
      cipher,
      mint,
      clock,
      graceSeconds: 30,
      keyVersion: 1,
    });
    expect(await reasonOf(odd.generate(p1()))).toBe('SERVICE_UNAVAILABLE');
    expect(await count('audit_log')).toBe(0);
    expect(await count('pseudonym_mapping')).toBe(0);
  });
});

describe('M2-05 spec 7.2 the clock is read once the lock is held', () => {
  it('M2-05 FR-33 a request that waited for the lock judges the token by the time it got the lock, not by the time it arrived', async () => {
    const first = await service.generate(p1());
    // Hold the lock of the combination in another transaction, as a slower request would.
    const holder = await db.app.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(TOKEN_SQL.lock, [
        `${index.lookup('CUSTOMER', CUSTOMER).toString('hex')}|TRANSACTION|PAYMENT_PROCESSING`,
      ]);
      const waiting = service.generate(p1());
      // Until the request is queued on the lock (observed in pg_locks, polled without a sleep) the clock must not move.
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const { rows } = await db.owner.query(
          `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        if (rows.length > 0) break;
      }
      clock.advance(TTL.PAYMENT_PROCESSING + 1);
      await holder.query('COMMIT');
      const second = await waiting;
      expect(second.reused).toBe(false);
      expect(second.pseudonym).not.toBe(first.pseudonym);
    } finally {
      holder.release();
    }
  });
});

describe('M2-05 spec 7.1 a token in its grace period does not block a new issue', () => {
  it('M2-05 FR-33 one second past the TTL (inside the 30 s grace) the next issue marks the old row expired and gives a new token', async () => {
    const first = await service.generate(p1());
    clock.advance(TTL.PAYMENT_PROCESSING + 1);
    const second = await service.generate(p1());
    expect(second.pseudonym).not.toBe(first.pseudonym);
    const old = (await mappings()).find((r) => r['pseudonym'] === first.pseudonym);
    expect(old?.['status']).toBe('expired');
  });
});

describe('M2-05 T-05 parallel requests that are not all alike', () => {
  it('M2-05 NFR-13 two combinations and refusals at once: one new token for each combination, every refusal audited, nothing else written', async () => {
    const calls = [
      ...Array.from({ length: 12 }, () => service.generate(p1({ subjectId: 'CUST-000301' }))),
      ...Array.from({ length: 12 }, () =>
        service.generate(p1({ subjectType: 'ACCOUNT', subjectId: '1234567890' })),
      ),
      ...Array.from({ length: 12 }, () =>
        reasonOf(service.generate(p1({ requestingService: 'TRANSACTION' }))),
      ),
    ];
    const settled = await Promise.all(calls);
    const issued = settled.filter((r) => typeof r !== 'string') as { reused: boolean }[];
    expect(issued.filter((r) => !r.reused)).toHaveLength(2);
    expect(issued.filter((r) => r.reused)).toHaveLength(22);
    expect(settled.filter((r) => r === 'POLICY_NOT_ALLOWED')).toHaveLength(12);
    expect(await count('pseudonym_mapping')).toBe(2);
    expect(await count('audit_log')).toBe(36);
  });
});

describe('M2-05 NFR-04 the queries of buat_token use the indexes at 20,000 rows', () => {
  it('M2-05 NFR-04 neither finding the active token nor marking the expired ones scans the table', async () => {
    await db.owner.query(`
      INSERT INTO pseudonym_mapping
        (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at, status)
      SELECT 'CUSTOMER', '\\x00'::bytea, decode(lpad(to_hex(g), 64, '0'), 'hex'),
             'PSEU-' || lpad(upper(to_hex(g)), 8, '0'), 'TRANSACTION', 'PAYMENT_PROCESSING',
             '2027-01-01T00:00:00Z', 'active'
        FROM generate_series(1, 20000) AS g`);
    await db.owner.query('ANALYZE pseudonym_mapping');
    const lookup = index.lookup('CUSTOMER', CUSTOMER);
    const plan = async (sql: string, values: unknown[]): Promise<string> =>
      (await db.app.query(`EXPLAIN ${sql}`, values)).rows
        .map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN'])
        .join('\n');
    const both = await plan(TOKEN_SQL.expireAndFindActive, [
      lookup,
      'TRANSACTION',
      'PAYMENT_PROCESSING',
      new Date(START),
    ]);
    // Both halves of the statement (the UPDATE and the SELECT) read through an index.
    expect(both).not.toMatch(/Seq Scan/);
  });
});

describe('ADR-0019 generateBatch', () => {
  const account = (over: Partial<GenerateRequest> = {}): GenerateRequest =>
    p1({ subjectType: 'ACCOUNT', subjectId: '90000000001', ...over });

  function observed(statements: string[], lookups: string[]): TokenService {
    return new TokenService({
      operation: new AuditedOperation(recording(db.app, statements), new AuditWriter()),
      policy: new PolicyEngine(TTL),
      // The order of the lookups is the order in which the advisory locks are taken (lookup comes right before the lock).
      index: {
        lookup: (subjectType, subjectId) => {
          lookups.push(subjectType);
          return index.lookup(subjectType, subjectId);
        },
      },
      cipher,
      mint,
      clock,
      graceSeconds: 30,
      keyVersion: 1,
    });
  }

  it('ADR-0019 the locks are taken in the same order whatever the order of the request, and the answer follows the request', async () => {
    const lookups: string[] = [];
    const counted = observed([], lookups);

    const forward = await counted.generateBatch([p1(), account()]);
    const turned = await counted.generateBatch([account(), p1()]);

    expect(lookups).toEqual(['ACCOUNT', 'CUSTOMER', 'ACCOUNT', 'CUSTOMER']);
    expect(turned[0]?.pseudonym).toBe(forward[1]?.pseudonym);
    expect(turned[1]?.pseudonym).toBe(forward[0]?.pseudonym);
  });

  it('ADR-0019 a pair costs one BEGIN and one COMMIT, where two single calls cost two of each', async () => {
    const statements: string[] = [];
    const counted = observed(statements, []);

    await counted.generateBatch([p1(), account()]);

    expect(statements.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(statements.filter((sql) => sql.startsWith('INSERT INTO audit_log'))).toHaveLength(2);
  });

  it('ADR-0019 a batch of three, of none, or of one subject type twice is refused before anything is read', async () => {
    const statements: string[] = [];
    const counted = observed(statements, []);
    const other = p1({ subjectId: 'CUST-000102' });

    expect(await reasonOf(counted.generateBatch([]))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(counted.generateBatch([p1(), account(), p1()]))).toBe('VALIDATION_ERROR');
    expect(await reasonOf(counted.generateBatch([p1(), other]))).toBe('VALIDATION_ERROR');
    expect(statements).toEqual([]);
  });
});
