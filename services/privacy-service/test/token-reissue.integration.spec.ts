import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditReader, AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys, mappingBinding } from '../src/crypto';
import { PolicyEngine } from '../src/policy';
import {
  TokenService,
  TransactionStatusService,
  type ReIssueRequest,
  type TransactionStatus,
} from '../src/token';

// Seam: TokenService.reIssue and TransactionStatusService.update on the real privacy database, as the real runtime
// roles, with a FakeClock. Every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
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
const START = '2026-10-20T08:00:00.000Z';

let db: TestDb;
let clock: FakeClock;
let reader: AuditReader;
let tokens: TokenService;
let statuses: TransactionStatusService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm207' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  if (db.auditor === undefined) throw new Error('the privacy test database has an auditor pool');
  reader = new AuditReader(db.auditor);
  clock = new FakeClock(START);
  const policy = new PolicyEngine(TTL);
  tokens = new TokenService({
    operation: new AuditedOperation(db.app, new AuditWriter()),
    policy,
    index,
    cipher,
    mint: new TokenMint(keys),
    clock,
    graceSeconds: GRACE,
    keyVersion: 1,
  });
  statuses = new TransactionStatusService({ pool: db.app, policy, clock });
});
afterEach(async () => {
  await db.close();
});

/** The Gateway issues P1 at the start of the payment. */
async function issueP1(transactionId = 'TX-6001', subjectId = CUSTOMER): Promise<string> {
  return (
    await tokens.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'CUSTOMER',
      subjectId,
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId,
    })
  ).pseudonym;
}

const reIssue = (pseudonym: string, over: Partial<ReIssueRequest> = {}): ReIssueRequest => ({
  requestingService: 'TRANSACTION',
  pseudonym,
  transactionId: 'TX-6001',
  ...over,
});
const setStatus = (transactionId: string, status: string, requestingService = 'TRANSACTION') =>
  statuses.update({ requestingService, transactionId, status: status as TransactionStatus });

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

describe('M2-07 FR-17 K-09 PATCH /transaction-status: an idempotent upsert that terminal statuses cannot leave', () => {
  it('M2-07 FR-17 creates the row, then moves it along; the row says when', async () => {
    const created = await setStatus('TX-6001', 'PENDING');
    expect(created).toEqual({
      transactionId: 'TX-6001',
      status: 'PENDING',
      updatedAt: new Date(START),
    });
    clock.advance(5);
    const moved = await setStatus('TX-6001', 'IN_PROGRESS');
    expect(moved.updatedAt.toISOString()).toBe('2026-10-20T08:00:05.000Z');
    expect(await count('transaction_status')).toBe(1);
  });

  it.each([
    ['IN_PROGRESS', 'PENDING'],
    ['PENDING', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
  ])('M2-07 FR-17 %s to %s stays possible while the transaction is not final', async (from, to) => {
    await setStatus('TX-6002', from);
    expect((await setStatus('TX-6002', to)).status).toBe(to);
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])(
    'M2-07 K-09 %s is final: repeating it changes nothing, any other status is TX_TERMINAL (409)',
    async (terminal) => {
      const first = await setStatus('TX-6003', terminal);
      clock.advance(60);
      expect(await setStatus('TX-6003', terminal)).toEqual(first);
      for (const other of ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'].filter(
        (s) => s !== terminal,
      )) {
        expect(await reasonOf(setStatus('TX-6003', other))).toBe('TX_TERMINAL');
      }
      const { rows } = await db.owner.query(
        'SELECT status, updated_at FROM transaction_status WHERE transaction_id = $1',
        ['TX-6003'],
      );
      expect(rows[0]).toMatchObject({ status: terminal, updated_at: first.updatedAt });
    },
  );

  it('M2-07 FR-17 it is not audited, refusals included (it is not a token operation)', async () => {
    await setStatus('TX-6004', 'COMPLETED');
    await reasonOf(setStatus('TX-6004', 'PENDING'));
    await reasonOf(setStatus('TX-6004', 'PENDING', 'NOTIFICATION'));
    expect(await count('audit_log')).toBe(0);
  });

  it('M2-07 AZ-24 only TRANSACTION may update a status: NOTIFICATION and the others are POLICY_NOT_ALLOWED, nothing written', async () => {
    for (const caller of [
      'NOTIFICATION',
      'FRAUD',
      'RECONCILIATION',
      'API_GATEWAY',
      'ADMIN_CONSOLE',
    ]) {
      expect(await reasonOf(setStatus('TX-6005', 'PENDING', caller))).toBe('POLICY_NOT_ALLOWED');
    }
    expect(await count('transaction_status')).toBe(0);
  });

  it.each([
    ['a status outside the five', 'TX-6006', 'DONE'],
    ['a status in lower case', 'TX-6006', 'completed'],
    ['no status', 'TX-6006', undefined],
    ['a transaction id of the wrong shape', 'TX-60 06', 'PENDING'],
    ['a transaction id that is not text', 6006, 'PENDING'],
  ])(
    'M2-07 FR-17 %s is VALIDATION_ERROR and writes nothing',
    async (_name, transactionId, status) => {
      expect(
        await reasonOf(
          statuses.update({
            requestingService: 'TRANSACTION',
            transactionId: transactionId as string,
            status: status as TransactionStatus,
          }),
        ),
      ).toBe('VALIDATION_ERROR');
      expect(await count('transaction_status')).toBe(0);
    },
  );

  it('M2-07 K-09 parallel updates: a final status wins whatever the order, and every call either succeeds or is TX_TERMINAL', async () => {
    const calls = [
      ...Array.from({ length: 10 }, () => setStatus('TX-6007', 'IN_PROGRESS').then(() => 'ok')),
      setStatus('TX-6007', 'COMPLETED').then(() => 'ok'),
      ...Array.from({ length: 10 }, () => setStatus('TX-6007', 'PENDING').then(() => 'ok')),
    ].map((call) => call.catch((error: unknown) => (error as DomainError).reason));
    const outcomes = await Promise.all(calls);
    for (const outcome of outcomes) expect(['ok', 'TX_TERMINAL']).toContain(outcome);
    const { rows } = await db.owner.query('SELECT status FROM transaction_status');
    expect(rows).toEqual([{ status: 'COMPLETED' }]);
  });
});

describe('M2-07 FR-10 FR-11 re-issue (spec privacy 7.7, PRD 7.5)', () => {
  it('M2-07 FR-10 TK-04: the old token is marked expired and a different token takes its place for the same service, purpose and subject', async () => {
    const old = await issueP1();
    clock.advance(60);
    const result = await tokens.reIssue(reIssue(old, { transactionId: 'TX-6001' }));
    expect(result.reused).toBe(false);
    expect(result.pseudonym).not.toBe(old);
    expect(result.expiresAt.toISOString()).toBe('2026-10-20T08:16:00.000Z');

    expect((await rowOf(old))?.['status']).toBe('expired');
    const fresh = await rowOf(result.pseudonym);
    expect(fresh).toMatchObject({
      service_id: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      subject_type: 'CUSTOMER',
      status: 'active',
      transaction_id: 'TX-6001',
    });
    expect(subjectOf(fresh)).toBe(CUSTOMER);
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'pseudonym', 'reused']);
    expect(await lastAudit()).toMatchObject({
      action: 'RE_ISSUE',
      status: 'SUCCESS',
      reason: 'OK',
      requestingService: 'TRANSACTION',
      pseudonym: result.pseudonym,
      mappingId: fresh?.['id'],
      transactionId: 'TX-6001',
    });
  });

  it('M2-07 C-05 called twice with the same old token, the second call gives the same new token (safe to repeat)', async () => {
    const old = await issueP1();
    const first = await tokens.reIssue(reIssue(old));
    const second = await tokens.reIssue(reIssue(old));
    expect(second.pseudonym).toBe(first.pseudonym);
    expect(second.reused).toBe(true);
    const { rows } = await db.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pseudonym_mapping WHERE status = 'active'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect((await reader.query({ action: 'RE_ISSUE' })).map((r) => r.reason)).toEqual([
      'REUSED_ACTIVE',
      'OK',
    ]);
  });

  it('M2-07 NFR-13 ten parallel re-issues of one token: one new token, nine given back, one active row', async () => {
    const old = await issueP1();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => tokens.reIssue(reIssue(old))),
    );
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(new Set(results.map((r) => r.pseudonym)).size).toBe(1);
    const { rows } = await db.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pseudonym_mapping WHERE status = 'active'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('M2-07 FR-10 the point of it: a token past its TTL and its grace (still stored active, or stored expired) is re-issued', async () => {
    const old = await issueP1();
    clock.advance(TTL.PAYMENT_PROCESSING + GRACE + 1);
    const fresh = await tokens.reIssue(reIssue(old));
    expect(fresh.reused).toBe(false);
    expect((await rowOf(old))?.['status']).toBe('expired');

    const another = await issueP1('TX-6010', 'CUST-000102');
    await db.owner.query(`UPDATE pseudonym_mapping SET status = 'expired' WHERE pseudonym = $1`, [
      another,
    ]);
    expect((await tokens.reIssue(reIssue(another, { transactionId: 'TX-6010' }))).reused).toBe(
      false,
    );
  });

  it.each([[undefined], ['PENDING'], ['IN_PROGRESS']])(
    'M2-07 FR-10 a transaction that is not final (status %s; no row means not final) can be re-issued',
    async (status) => {
      const old = await issueP1();
      if (status !== undefined) await setStatus('TX-6001', status);
      expect((await tokens.reIssue(reIssue(old))).reused).toBe(false);
    },
  );

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])(
    'M2-07 TK-09 FR-11 a %s transaction is TX_TERMINAL (409); the old token stays as it was and nothing is issued',
    async (terminal) => {
      const old = await issueP1();
      await setStatus('TX-6001', terminal);
      const rows = await count('pseudonym_mapping');
      expect(await reasonOf(tokens.reIssue(reIssue(old)))).toBe('TX_TERMINAL');
      expect((await rowOf(old))?.['status']).toBe('active');
      expect(await count('pseudonym_mapping')).toBe(rows);
      expect(await lastAudit()).toMatchObject({
        action: 'RE_ISSUE',
        status: 'DENIED',
        reason: 'TX_TERMINAL',
        pseudonym: old,
        transactionId: 'TX-6001',
      });
    },
  );
});

describe('M2-07 FR-10 re-issue refusals, one audited DENIED row each', () => {
  const denied = async (work: Promise<unknown>, reason: string, audit: Record<string, unknown>) => {
    const before = await count('pseudonym_mapping');
    expect(await reasonOf(work)).toBe(reason);
    expect(await count('pseudonym_mapping')).toBe(before);
    expect(await lastAudit()).toMatchObject({
      action: 'RE_ISSUE',
      status: 'DENIED',
      reason,
      ...audit,
    });
  };

  it('M2-07 AZ-23 any service but TRANSACTION is POLICY_NOT_ALLOWED, before the token is read', async () => {
    const old = await issueP1();
    for (const caller of [
      'FRAUD',
      'NOTIFICATION',
      'RECONCILIATION',
      'API_GATEWAY',
      'ADMIN_CONSOLE',
    ]) {
      await denied(
        tokens.reIssue(reIssue(old, { requestingService: caller })),
        'POLICY_NOT_ALLOWED',
        {
          requestingService: caller,
          pseudonym: old,
        },
      );
    }
    // The same answer for a token that does not exist: the caller learns nothing about tokens.
    await denied(
      tokens.reIssue(reIssue('PSEU-DEADBEEF', { requestingService: 'FRAUD' })),
      'POLICY_NOT_ALLOWED',
      { pseudonym: 'PSEU-DEADBEEF' },
    );
  });

  it('M2-07 TK-05 a token that does not exist is TOKEN_NOT_FOUND', async () => {
    await denied(tokens.reIssue(reIssue('PSEU-DEADBEEF')), 'TOKEN_NOT_FOUND', {
      pseudonym: 'PSEU-DEADBEEF',
    });
  });

  it('M2-07 TK-01 a token of another service is SERVICE_MISMATCH', async () => {
    const fraud = (
      await tokens.exchange({
        requestingService: 'TRANSACTION',
        sourcePseudonym: await issueP1(),
        targetService: 'FRAUD',
        purpose: 'FRAUD_DETECTION',
        transactionId: 'TX-6001',
      })
    ).pseudonym;
    await denied(tokens.reIssue(reIssue(fraud)), 'SERVICE_MISMATCH', { pseudonym: fraud });
  });

  it('M2-07 FR-10 a token of TRANSACTION outside P1 and P2 is POLICY_NOT_ALLOWED: re-issue never changes what a token is for', async () => {
    const id = randomUUID();
    await db.owner.query(
      `INSERT INTO pseudonym_mapping (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, expires_at)
       VALUES ($1, 'CUSTOMER', $2, $3, 'PSEU-0000C0DE', 'TRANSACTION', 'FRAUD_DETECTION', '2027-01-01T00:00:00Z')`,
      [
        id,
        cipher.encrypt(CUSTOMER, mappingBinding('CUSTOMER', id)),
        index.lookup('CUSTOMER', CUSTOMER),
      ],
    );
    await denied(tokens.reIssue(reIssue('PSEU-0000C0DE')), 'POLICY_NOT_ALLOWED', {
      pseudonym: 'PSEU-0000C0DE',
    });
  });

  it('M2-07 TK-17 a revoked token is REVOKED', async () => {
    const old = await issueP1();
    await db.owner.query(
      `UPDATE pseudonym_mapping SET status = 'revoked', revoked_at = now() WHERE pseudonym = $1`,
      [old],
    );
    await denied(tokens.reIssue(reIssue(old)), 'REVOKED', { pseudonym: old });
  });

  it('M2-07 FR-10 a row whose identity retention emptied is TOKEN_NOT_FOUND', async () => {
    const old = await issueP1();
    await db.owner.query(
      `UPDATE pseudonym_mapping SET subject_id_enc = NULL, subject_lookup = NULL, purged_at = now(), status = 'expired' WHERE pseudonym = $1`,
      [old],
    );
    await denied(tokens.reIssue(reIssue(old)), 'TOKEN_NOT_FOUND', { pseudonym: old });
  });

  it.each([
    ['a pseudonym that is not one', reIssue('CUST-000101')],
    ['no transaction id', reIssue('PSEU-0000AAAA', { transactionId: undefined as never })],
    ['a transaction id of the wrong shape', reIssue('PSEU-0000AAAA', { transactionId: 'TX-1 2' })],
    [
      'a requesting service that is not an identifier',
      reIssue('PSEU-0000AAAA', { requestingService: 'a b' }),
    ],
  ])('M2-07 FR-10 %s is VALIDATION_ERROR, not audited', async (_name, request) => {
    expect(await reasonOf(tokens.reIssue(request))).toBe('VALIDATION_ERROR');
    expect(await count('audit_log')).toBe(0);
  });
});

describe('M2-07 FR-13 re-issue is atomic with its audit row and with concurrent changes', () => {
  it('M2-07 FR-13 a commit the database refuses leaves the old token active, no new token, no audit row', async () => {
    const old = await issueP1();
    await db.owner.query(`
      CREATE FUNCTION refuse_audit_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
      CREATE CONSTRAINT TRIGGER refuse_audit AFTER INSERT ON audit_log
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_audit_at_commit();`);
    await db.owner.query('DELETE FROM audit_log');
    const mappings = await count('pseudonym_mapping');
    expect(await reasonOf(tokens.reIssue(reIssue(old)))).toBe('INTERNAL_ERROR');
    expect((await rowOf(old))?.['status']).toBe('active');
    expect(await count('pseudonym_mapping')).toBe(mappings);
  });

  /** Holds an uncommitted change, starts `run`, waits (pg_locks, no sleep) until it is queued, then commits. */
  async function whileChangeIsPending(
    change: { sql: string; values: unknown[] },
    run: () => Promise<unknown>,
  ): Promise<{ error?: unknown; value?: unknown }> {
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(change.sql, change.values);
      const state = { settled: false };
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
      for (let polls = 0; polls < 5000 && !state.settled; polls += 1) {
        const { rows } = await db.owner.query(
          `SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`,
        );
        if (rows.length > 0) break;
      }
      await holder.query('COMMIT');
      return await pending;
    } finally {
      holder.release();
    }
  }

  it('M2-07 TK-09 a transaction that becomes final while the re-issue is in flight is seen: TX_TERMINAL, the old token untouched', async () => {
    const old = await issueP1();
    await setStatus('TX-6001', 'IN_PROGRESS');
    const outcome = await whileChangeIsPending(
      {
        sql: `UPDATE transaction_status SET status = 'COMPLETED' WHERE transaction_id = $1`,
        values: ['TX-6001'],
      },
      () => tokens.reIssue(reIssue(old)),
    );
    expect((outcome.error as DomainError | undefined)?.reason).toBe('TX_TERMINAL');
    expect((await rowOf(old))?.['status']).toBe('active');
  });

  it('M2-07 TK-17 a revocation in flight is seen: REVOKED, nothing issued', async () => {
    const old = await issueP1();
    const outcome = await whileChangeIsPending(
      {
        sql: `UPDATE pseudonym_mapping SET status = 'revoked', revoked_at = now() WHERE pseudonym = $1`,
        values: [old],
      },
      () => tokens.reIssue(reIssue(old)),
    );
    expect((outcome.error as DomainError | undefined)?.reason).toBe('REVOKED');
    expect(await count('pseudonym_mapping')).toBe(1);
  });
});
