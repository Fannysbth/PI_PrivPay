import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditReader, AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys, mappingBinding } from '../src/crypto';
import { PolicyEngine } from '../src/policy';
import {
  TOKEN_SQL,
  TokenService,
  type ExchangeRequest,
  type FromTransactionRequest,
} from '../src/token';

// Seam: TokenService.exchange (form 2) and TokenService.generateFromTransaction (form 3) on the real privacy database,
// as the real runtime roles, with a FakeClock. Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
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
const TTL = {
  PAYMENT_PROCESSING: 900,
  FRAUD_DETECTION: 2_592_000,
  NOTIFICATION: 900,
  NOTIFICATION_REGISTRATION: 31_536_000,
  DAILY_RECONCILIATION: 86_400,
  INTERNAL_AUDIT: 600,
};
const GRACE = 30;
const CUSTOMER = 'CUST-000101';
const ACCOUNT = '1234567801';

let db: TestDb;
let clock: FakeClock;
let reader: AuditReader;
let service: TokenService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm206' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  reader = new AuditReader(db.auditor);
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  service = new TokenService({
    operation: new AuditedOperation(db.app, new AuditWriter()),
    policy: new PolicyEngine(TTL),
    index,
    cipher,
    mint: new TokenMint(keys),
    clock,
    graceSeconds: GRACE,
    keyVersion: 1,
  });
});
afterEach(async () => {
  await db.close();
});

/** What the Gateway does at the start of a payment: P1 for the customer, P2 for the account, with the transaction id. */
async function issueP1(transactionId = 'TX-5001'): Promise<string> {
  return (
    await service.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'CUSTOMER',
      subjectId: CUSTOMER,
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId,
    })
  ).pseudonym;
}
async function issueP2(transactionId = 'TX-5001'): Promise<string> {
  return (
    await service.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'ACCOUNT',
      subjectId: ACCOUNT,
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId,
    })
  ).pseudonym;
}

const toFraud = (source: string, over: Partial<ExchangeRequest> = {}): ExchangeRequest => ({
  requestingService: 'TRANSACTION',
  sourcePseudonym: source,
  targetService: 'FRAUD',
  purpose: 'FRAUD_DETECTION',
  transactionId: 'TX-5001',
  ...over,
});
const toNotification = (source: string): ExchangeRequest =>
  toFraud(source, { targetService: 'NOTIFICATION', purpose: 'NOTIFICATION' });

const p6 = (over: Partial<FromTransactionRequest> = {}): FromTransactionRequest => ({
  requestingService: 'RECONCILIATION',
  transactionId: 'TX-5001',
  targetService: 'RECONCILIATION',
  purpose: 'DAILY_RECONCILIATION',
  subjectType: 'ACCOUNT',
  ...over,
});
const p7 = (over: Partial<FromTransactionRequest> = {}): FromTransactionRequest =>
  p6({
    purpose: 'INTERNAL_AUDIT',
    subjectType: 'CUSTOMER',
    actorRole: 'auditor',
    actorId: 'auditor-a',
    ...over,
  });

const count = async (table: string): Promise<number> => {
  // The table name is a constant of this test.
  const { rows } = await db.owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
};
const rowOf = async (pseudonym: string): Promise<Record<string, unknown> | undefined> =>
  (
    await db.owner.query<Record<string, unknown>>(
      'SELECT * FROM pseudonym_mapping WHERE pseudonym = $1',
      [pseudonym],
    )
  ).rows[0];
const subjectOf = (row: Record<string, unknown> | undefined): string =>
  cipher.decrypt(
    row?.['subject_id_enc'] as Buffer,
    mappingBinding(String(row?.['subject_type']), String(row?.['id'])),
  );
const lastAudit = async () => (await reader.query({ limit: 1 }))[0];

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}

describe('M2-06 FR-07 FR-28 exchange: the two exchanges of Tabel 2 (spec privacy 7.5)', () => {
  it('M2-06 FR-07 X1: TRANSACTION trades its P1 token for a token of FRAUD, the same subject, the TTL of the purpose', async () => {
    const source = await issueP1();
    const result = await service.exchange(toFraud(source));
    expect(result.reused).toBe(false);
    expect(result.pseudonym).not.toBe(source);
    expect(result.expiresAt.toISOString()).toBe('2026-11-19T08:00:00.000Z');
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'pseudonym', 'reused']);

    const row = await rowOf(result.pseudonym);
    expect(row).toMatchObject({
      service_id: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
      subject_type: 'CUSTOMER',
      transaction_id: 'TX-5001',
      status: 'active',
    });
    expect(subjectOf(row)).toBe(CUSTOMER);
    expect(row?.['subject_lookup']).toEqual(index.lookup('CUSTOMER', CUSTOMER));
  });

  it('M2-06 FR-07 X2: P1 to a token of NOTIFICATION', async () => {
    const result = await service.exchange(toNotification(await issueP1()));
    expect(await rowOf(result.pseudonym)).toMatchObject({
      service_id: 'NOTIFICATION',
      purpose: 'NOTIFICATION',
    });
  });

  it('M2-06 FR-07 a repeat gives the active token back, audited as REUSED_ACTIVE; one audit row per call', async () => {
    const source = await issueP1();
    const first = await service.exchange(toFraud(source));
    const second = await service.exchange(toFraud(source));
    expect(second).toEqual({ ...first, reused: true });
    const audit = (await reader.query({ action: 'EXCHANGE_TOKEN' })).map((r) => r.reason);
    expect(audit).toEqual(['REUSED_ACTIVE', 'OK']);
  });

  it('M2-06 FR-07 the audit row of a success names the new token and its row, the purpose asked for, and no subject', async () => {
    const source = await issueP1();
    const result = await service.exchange(toFraud(source, { actorId: 'SYSTEM' }));
    const row = await rowOf(result.pseudonym);
    expect(await lastAudit()).toMatchObject({
      action: 'EXCHANGE_TOKEN',
      status: 'SUCCESS',
      reason: 'OK',
      requestingService: 'TRANSACTION',
      pseudonym: result.pseudonym,
      mappingId: row?.['id'],
      purpose: 'FRAUD_DETECTION',
      transactionId: 'TX-5001',
      actorId: 'SYSTEM',
      keyVersion: 1,
    });
    const everything = JSON.stringify([await reader.query({}), result, row]);
    expect(everything).not.toContain(CUSTOMER);
  });

  it('M2-06 NFR-13 20 parallel exchanges of one token: one new token, 19 given back, one active row', async () => {
    const source = await issueP1();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.exchange(toFraud(source))),
    );
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(new Set(results.map((r) => r.pseudonym)).size).toBe(1);
    const { rows } = await db.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pseudonym_mapping WHERE service_id = 'FRAUD' AND status = 'active'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});

describe('M2-06 TK-13 TK-14 STEP 0 and STEP 2: only the pairs of Tabel 2, decided before and after the token is read', () => {
  const refusedAs = async (
    work: Promise<unknown>,
    reason: string,
    audit: Record<string, unknown>,
  ): Promise<void> => {
    const before = await count('pseudonym_mapping');
    expect(await reasonOf(work)).toBe(reason);
    expect(await count('pseudonym_mapping')).toBe(before);
    expect(await lastAudit()).toMatchObject({
      action: 'EXCHANGE_TOKEN',
      status: 'DENIED',
      reason,
      ...audit,
    });
  };

  it('M2-06 TK-13 FRAUD trading its token for one of NOTIFICATION is POLICY_NOT_ALLOWED, however valid the token', async () => {
    const fraudToken = (await service.exchange(toFraud(await issueP1()))).pseudonym;
    await refusedAs(
      service.exchange({ ...toNotification(fraudToken), requestingService: 'FRAUD' }),
      'POLICY_NOT_ALLOWED',
      { requestingService: 'FRAUD' },
    );
  });

  it.each([
    ['RECONCILIATION', 'INTERNAL_AUDIT'],
    ['NOTIFICATION', 'NOTIFICATION_REGISTRATION'],
    ['FRAUD', 'PAYMENT_PROCESSING'],
    ['TRANSACTION', 'PAYMENT_PROCESSING'],
    ['MARKETING', 'FRAUD_DETECTION'],
  ])(
    'M2-06 TK-13 TRANSACTION asking for %s/%s is POLICY_NOT_ALLOWED before the token is even read',
    async (target, purpose) => {
      // The source token does not exist: only STEP 0 can be what refuses.
      await refusedAs(
        service.exchange(toFraud('PSEU-0000FFFF', { targetService: target, purpose })),
        'POLICY_NOT_ALLOWED',
        { pseudonym: 'PSEU-0000FFFF' },
      );
    },
  );

  it('M2-06 TK-14 a P2 (ACCOUNT) token cannot be traded: its target would be a context outside Tabel 1', async () => {
    const account = await issueP2();
    await refusedAs(service.exchange(toFraud(account)), 'POLICY_NOT_ALLOWED', {
      pseudonym: account,
    });
  });

  it('M2-06 TK-13 STEP 2: a token of another context of TRANSACTION is refused although its owner is the caller', async () => {
    // A P1-shaped row owned by TRANSACTION but with a purpose Tabel 2 does not list as a source.
    const id = randomUUID();
    await db.owner.query(
      `INSERT INTO pseudonym_mapping (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
       VALUES ($1, 'CUSTOMER', $2, $3, 'PSEU-0000B0B0', 'TRANSACTION', 'FRAUD_DETECTION', '2027-01-01T00:00:00Z')`,
      [
        id,
        cipher.encrypt(CUSTOMER, mappingBinding('CUSTOMER', id)),
        index.lookup('CUSTOMER', CUSTOMER),
      ],
    );
    await refusedAs(service.exchange(toFraud('PSEU-0000B0B0')), 'POLICY_NOT_ALLOWED', {
      pseudonym: 'PSEU-0000B0B0',
    });
  });
});

describe("M2-06 FR-07 STEP 1: the token exists, is the caller's, and is usable", () => {
  const denied = async (work: Promise<unknown>, reason: string, audit: Record<string, unknown>) => {
    const before = await count('pseudonym_mapping');
    expect(await reasonOf(work)).toBe(reason);
    expect(await count('pseudonym_mapping')).toBe(before);
    expect(await lastAudit()).toMatchObject({
      action: 'EXCHANGE_TOKEN',
      status: 'DENIED',
      reason,
      ...audit,
    });
  };

  it('M2-06 TK-05 a token that does not exist is TOKEN_NOT_FOUND', async () => {
    await denied(service.exchange(toFraud('PSEU-DEADBEEF')), 'TOKEN_NOT_FOUND', {
      pseudonym: 'PSEU-DEADBEEF',
    });
  });

  it('M2-06 TK-01 a token of another service is SERVICE_MISMATCH', async () => {
    const fraudToken = (await service.exchange(toFraud(await issueP1()))).pseudonym;
    await denied(service.exchange(toFraud(fraudToken)), 'SERVICE_MISMATCH', {
      pseudonym: fraudToken,
    });
  });

  it('M2-06 TK-17 a revoked token is REVOKED', async () => {
    const source = await issueP1();
    await db.owner.query(
      `UPDATE pseudonym_mapping SET status = 'revoked', revoked_at = now() WHERE pseudonym = $1`,
      [source],
    );
    await denied(service.exchange(toFraud(source)), 'REVOKED', { pseudonym: source });
  });

  it('M2-06 FR-07 an expired token is EXPIRED: stored as such, or past its TTL plus the grace period', async () => {
    const stored = await issueP1('TX-5002');
    await db.owner.query(`UPDATE pseudonym_mapping SET status = 'expired' WHERE pseudonym = $1`, [
      stored,
    ]);
    await denied(service.exchange(toFraud(stored)), 'EXPIRED', { pseudonym: stored });

    const other = await service.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'CUSTOMER',
      subjectId: 'CUST-000102',
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId: 'TX-5003',
    });
    clock.advance(TTL.PAYMENT_PROCESSING + GRACE + 1);
    await denied(service.exchange(toFraud(other.pseudonym)), 'EXPIRED', {
      pseudonym: other.pseudonym,
    });
  });

  it('M2-06 FR-07 inside the grace period the operation already under way is still accepted (spec 7.1)', async () => {
    const source = await issueP1();
    clock.advance(TTL.PAYMENT_PROCESSING + GRACE);
    const result = await service.exchange(toFraud(source));
    expect(result.reused).toBe(false);
  });

  it('M2-06 FR-07 a row whose identity retention has already emptied is TOKEN_NOT_FOUND, not a decryption error', async () => {
    const source = await issueP1();
    await db.owner.query(
      `UPDATE pseudonym_mapping SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = now() WHERE pseudonym = $1`,
      [source],
    );
    await denied(service.exchange(toFraud(source)), 'TOKEN_NOT_FOUND', { pseudonym: source });
  });
});

describe('M2-06 a request of the wrong shape is refused before anything is read or audited', () => {
  it.each([
    ['a source that is not a pseudonym', toFraud('CUST-000101')],
    ['a source in lower case', toFraud('pseudonym-1')],
    ['no transaction id', toFraud('PSEU-0000AAAA', { transactionId: undefined as never })],
    ['a transaction id of the wrong shape', toFraud('PSEU-0000AAAA', { transactionId: 'TX-1 2' })],
    [
      'a purpose that is not an identifier',
      toFraud('PSEU-0000AAAA', { purpose: 'fraud detection' }),
    ],
  ])('M2-06 FR-07 %s is VALIDATION_ERROR, not audited', async (_name, request) => {
    expect(await reasonOf(service.exchange(request))).toBe('VALIDATION_ERROR');
    expect(await count('audit_log')).toBe(0);
  });

  it('M2-06 FR-13 a commit the database refuses takes the exchanged token and its audit row down together', async () => {
    const source = await issueP1();
    await db.owner.query(`
      CREATE FUNCTION refuse_audit_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
      CREATE CONSTRAINT TRIGGER refuse_audit AFTER INSERT ON audit_log
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_audit_at_commit();`);
    const mappings = await count('pseudonym_mapping');
    expect(await reasonOf(service.exchange(toFraud(source)))).toBe('INTERNAL_ERROR');
    expect(await count('pseudonym_mapping')).toBe(mappings);
  });
});

describe('M2-06 FR-09 form 3: P6 and P7 from a transaction id (spec privacy 7.4)', () => {
  it('M2-06 FR-09 P6: RECONCILIATION gets a token for the account of the transaction, the same subject, the TTL of the purpose', async () => {
    const source = await issueP2();
    const result = await service.generateFromTransaction(p6());
    expect(result.pseudonym).not.toBe(source);
    expect(result.reused).toBe(false);
    expect(result.expiresAt.toISOString()).toBe('2026-10-21T08:00:00.000Z');
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'pseudonym', 'reused']);
    const row = await rowOf(result.pseudonym);
    expect(row).toMatchObject({
      service_id: 'RECONCILIATION',
      purpose: 'DAILY_RECONCILIATION',
      subject_type: 'ACCOUNT',
      transaction_id: 'TX-5001',
    });
    expect(subjectOf(row)).toBe(ACCOUNT);
    expect(await lastAudit()).toMatchObject({
      action: 'GENERATE_TOKEN',
      status: 'SUCCESS',
      reason: 'OK',
      requestingService: 'RECONCILIATION',
      pseudonym: result.pseudonym,
      purpose: 'DAILY_RECONCILIATION',
    });
  });

  it('M2-06 FR-09 P7: with an auditor as actor, a token for the customer; the actor is in the audit row', async () => {
    await issueP1();
    const result = await service.generateFromTransaction(p7());
    expect(result.expiresAt.toISOString()).toBe('2026-10-20T08:10:00.000Z');
    expect(subjectOf(await rowOf(result.pseudonym))).toBe(CUSTOMER);
    expect(await lastAudit()).toMatchObject({ actorId: 'auditor-a', purpose: 'INTERNAL_AUDIT' });
  });

  it.each([undefined, 'admin', 'fraud_analyst', 'AUDITOR'])(
    'M2-06 FR-09 TK-08 P7 with the actor role %s is FORBIDDEN_ROLE, audited, nothing issued',
    async (actorRole) => {
      await issueP1();
      const mappings = await count('pseudonym_mapping');
      expect(await reasonOf(service.generateFromTransaction(p7({ actorRole })))).toBe(
        'FORBIDDEN_ROLE',
      );
      expect(await count('pseudonym_mapping')).toBe(mappings);
      expect(await lastAudit()).toMatchObject({
        action: 'GENERATE_TOKEN',
        status: 'DENIED',
        reason: 'FORBIDDEN_ROLE',
      });
    },
  );

  it('M2-06 FR-09 a source row that has expired still serves: an old transaction can be reconciled', async () => {
    await issueP2();
    clock.advance(TTL.PAYMENT_PROCESSING * 10);
    await db.owner.query(
      `UPDATE pseudonym_mapping SET status = 'expired' WHERE service_id = 'TRANSACTION'`,
    );
    const result = await service.generateFromTransaction(p6());
    expect(subjectOf(await rowOf(result.pseudonym))).toBe(ACCOUNT);
  });

  it('M2-06 FR-09 a repeat for the same transaction gives the active token back', async () => {
    await issueP2();
    const first = await service.generateFromTransaction(p6());
    const second = await service.generateFromTransaction(p6());
    expect(second).toEqual({ ...first, reused: true });
    expect((await lastAudit())?.reason).toBe('REUSED_ACTIVE');
  });

  it('M2-06 FR-09 a source row whose identity was emptied by retention is TOKEN_NOT_FOUND', async () => {
    const source = await issueP2();
    await db.owner.query(
      `UPDATE pseudonym_mapping SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = now(), status = 'expired' WHERE pseudonym = $1`,
      [source],
    );
    expect(await reasonOf(service.generateFromTransaction(p6()))).toBe('TOKEN_NOT_FOUND');
    expect(await lastAudit()).toMatchObject({
      action: 'GENERATE_TOKEN',
      status: 'DENIED',
      reason: 'TOKEN_NOT_FOUND',
    });
  });

  it('M2-06 FR-09 a transaction nobody issued a token for is TOKEN_NOT_FOUND', async () => {
    expect(await reasonOf(service.generateFromTransaction(p6({ transactionId: 'TX-9999' })))).toBe(
      'TOKEN_NOT_FOUND',
    );
  });

  it('M2-06 FR-09 the subject type picks the source: a CUSTOMER request never reads the P2 row and the other way round', async () => {
    await issueP2('TX-5100');
    expect(await reasonOf(service.generateFromTransaction(p7({ transactionId: 'TX-5100' })))).toBe(
      'TOKEN_NOT_FOUND',
    );
    await issueP1('TX-5200');
    expect(await reasonOf(service.generateFromTransaction(p6({ transactionId: 'TX-5200' })))).toBe(
      'TOKEN_NOT_FOUND',
    );
  });

  it('M2-06 invariant 5 only a P1/P2 row of TRANSACTION is a source: a token of another service carrying the transaction id is not', async () => {
    // The exchange gives FRAUD's row the same transaction id; with no P1 row at all, that row must not serve.
    const id = randomUUID();
    await db.owner.query(
      `INSERT INTO pseudonym_mapping (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, transaction_id, expires_at)
       VALUES ($1, 'CUSTOMER', $2, $3, 'PSEU-0000F00D', 'FRAUD', 'FRAUD_DETECTION', 'TX-7001', '2027-01-01T00:00:00Z')`,
      [
        id,
        cipher.encrypt(CUSTOMER, mappingBinding('CUSTOMER', id)),
        index.lookup('CUSTOMER', CUSTOMER),
      ],
    );
    expect(await reasonOf(service.generateFromTransaction(p7({ transactionId: 'TX-7001' })))).toBe(
      'TOKEN_NOT_FOUND',
    );
  });
});

describe('M2-06 AZ-19 AZ-20 FR-04 who may use which form', () => {
  const CALLERS = [
    'API_GATEWAY',
    'TRANSACTION',
    'FRAUD',
    'NOTIFICATION',
    'RECONCILIATION',
    'ADMIN_CONSOLE',
  ];

  it('M2-06 AZ-19 exchange is for TRANSACTION alone', async () => {
    const source = await issueP1();
    for (const caller of CALLERS.filter((c) => c !== 'TRANSACTION')) {
      expect(await reasonOf(service.exchange(toFraud(source, { requestingService: caller })))).toBe(
        'POLICY_NOT_ALLOWED',
      );
    }
  });

  it('M2-06 AZ-20 form 3 is for RECONCILIATION alone', async () => {
    await issueP2();
    for (const caller of CALLERS.filter((c) => c !== 'RECONCILIATION')) {
      expect(
        await reasonOf(service.generateFromTransaction(p6({ requestingService: caller }))),
      ).toBe('POLICY_NOT_ALLOWED');
    }
  });

  it('M2-06 TK-07 form 1 stays for API_GATEWAY alone (a downstream service never hands over a subject id)', async () => {
    for (const caller of CALLERS.filter((c) => c !== 'API_GATEWAY')) {
      expect(
        await reasonOf(
          service.generate({
            requestingService: caller,
            subjectType: 'CUSTOMER',
            subjectId: CUSTOMER,
            targetService: 'TRANSACTION',
            purpose: 'PAYMENT_PROCESSING',
          }),
        ),
      ).toBe('POLICY_NOT_ALLOWED');
    }
  });

  it('M2-06 AZ-20 form 3 cannot reach a context outside P6 and P7', async () => {
    await issueP2();
    await issueP1();
    for (const request of [
      p6({ targetService: 'TRANSACTION', purpose: 'PAYMENT_PROCESSING' }),
      p6({ targetService: 'FRAUD', purpose: 'FRAUD_DETECTION', subjectType: 'CUSTOMER' }),
      p6({
        targetService: 'NOTIFICATION',
        purpose: 'NOTIFICATION_REGISTRATION',
        subjectType: 'CUSTOMER',
      }),
    ]) {
      expect(await reasonOf(service.generateFromTransaction(request))).toBe('POLICY_NOT_ALLOWED');
    }
  });
});

describe('M2-06 a source is read under a share lock: a concurrent revocation or purge is not lost', () => {
  /**
   * Holds an uncommitted change on a row, starts `run`, waits (polling pg_locks, no sleep) until `run` is queued on the
   * row, then commits the change. Whatever `run` decided, it decided after the change.
   */
  async function whileChangeIsPending(
    change: { sql: string; values: unknown[] },
    run: () => Promise<unknown>,
  ): Promise<{ error?: unknown; value?: unknown }> {
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(change.sql, change.values);
      const state = { settled: false, queued: false };
      const pending = run().then(
        (value) => {
          state.settled = true;
          return { value };
        },
        (error: unknown) => {
          state.settled = true;
          return { error };
        },
      );
      const until = Date.now() + 20_000;
      while (Date.now() < until && !state.settled) {
        const { rows } = await db.owner.query(
          `SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`,
        );
        if (rows.length > 0) {
          state.queued = true;
          break;
        }
      }
      // Without this, a run that never met the lock would pass without having tested the race.
      expect(state.queued).toBe(true);
      await holder.query('COMMIT');
      return await pending;
    } finally {
      holder.release();
    }
  }

  it('M2-06 TK-17 an exchange that meets a revocation still in flight waits for it and is refused REVOKED', async () => {
    const source = await issueP1();
    const outcome = await whileChangeIsPending(
      {
        sql: `UPDATE pseudonym_mapping SET status = 'revoked', revoked_at = now() WHERE pseudonym = $1`,
        values: [source],
      },
      () => service.exchange(toFraud(source)),
    );
    expect((outcome.error as DomainError | undefined)?.reason).toBe('REVOKED');
    expect(await count('pseudonym_mapping')).toBe(1);
  });

  it('M2-06 FR-09 a form 3 request that meets a retention purge still in flight waits for it and finds nothing', async () => {
    const source = await issueP2();
    const outcome = await whileChangeIsPending(
      {
        sql: `UPDATE pseudonym_mapping SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = now(), status = 'expired' WHERE pseudonym = $1`,
        values: [source],
      },
      () => service.generateFromTransaction(p6()),
    );
    expect((outcome.error as DomainError | undefined)?.reason).toBe('TOKEN_NOT_FOUND');
    expect(await count('pseudonym_mapping')).toBe(1);
  });
});

describe('M2-06 NFR-04 the statements that read a source use the indexes at 20,000 rows', () => {
  it('M2-06 NFR-04 neither finding a token by its value nor a source by its transaction id scans the table', async () => {
    await db.owner.query(`
      INSERT INTO pseudonym_mapping
        (subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, transaction_id, expires_at, status)
      SELECT 'CUSTOMER', '\\x00'::bytea, decode(lpad(to_hex(g), 64, '0'), 'hex'),
             'PSEU-' || lpad(upper(to_hex(g)), 8, '0'), 'TRANSACTION', 'PAYMENT_PROCESSING',
             'TX-' || g, '2027-01-01T00:00:00Z', 'active'
        FROM generate_series(1, 20000) AS g`);
    await db.owner.query('ANALYZE pseudonym_mapping');
    const plan = async (sql: string, values: unknown[]): Promise<string> =>
      (await db.app.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, values)).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
    expect(await plan(TOKEN_SQL.findSource, ['PSEU-00004E20'])).not.toMatch(/Seq Scan/);
    expect(
      await plan(TOKEN_SQL.findByTransaction, [
        'TX-777',
        'CUSTOMER',
        'TRANSACTION',
        'PAYMENT_PROCESSING',
      ]),
    ).not.toMatch(/Seq Scan/);
  });
});
