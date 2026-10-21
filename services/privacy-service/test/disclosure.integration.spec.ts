import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys } from '../src/crypto';
import { DisclosureService } from '../src/disclosure';
import { PolicyEngine } from '../src/policy';
import { TokenService } from '../src/token';

// Seam: DisclosureService (request, approve, reject) on the real privacy database, as the real runtime role, with a
// FakeClock. P7 tokens are made through TokenService, other states are written by the schema owner. Every value is
// invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const config = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', 'migrations');

const keys = createKeys({
  token: Buffer.alloc(32, 1),
  index: Buffer.alloc(32, 2),
  field: new Map([[1, Buffer.alloc(32, 3)]]),
  fieldVersion: 1,
});
const TTL = {
  PAYMENT_PROCESSING: 900,
  FRAUD_DETECTION: 2_592_000,
  NOTIFICATION: 900,
  NOTIFICATION_REGISTRATION: 31_536_000,
  DAILY_RECONCILIATION: 86_400,
  INTERNAL_AUDIT: 600,
};
const APPROVAL_TTL = 600;
const CUSTOMER = 'CUST-000101';
const AUDITOR = {
  requestingService: 'ADMIN_CONSOLE',
  actorId: 'usr-auditor',
  actorRole: 'auditor',
};
const ADMIN = { requestingService: 'ADMIN_CONSOLE', actorId: 'usr-admin', actorRole: 'admin' };
const ADMIN_TWO = { ...ADMIN, actorId: 'usr-admin-two' };

let db: TestDb;
let clock: FakeClock;
let tokens: TokenService;
let disclosure: DisclosureService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm304' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  const operation = new AuditedOperation(db.app, new AuditWriter());
  const policy = new PolicyEngine(TTL);
  tokens = new TokenService({
    operation,
    policy,
    index: new BlindIndex(keys),
    cipher: new FieldCipher(keys),
    mint: new TokenMint(keys),
    clock,
    graceSeconds: 30,
    keyVersion: 1,
  });
  disclosure = new DisclosureService({
    operation,
    policy,
    clock,
    graceSeconds: 30,
    approvalTtlSeconds: APPROVAL_TTL,
  });
});
afterEach(async () => {
  await db.close();
});

/** P1 by the Gateway, then P7 as Reconciliation gets it for an auditor (form 3). */
async function issueP7(transactionId = 'TX-9001'): Promise<string> {
  await tokens.generate({
    requestingService: 'API_GATEWAY',
    subjectType: 'CUSTOMER',
    subjectId: CUSTOMER,
    targetService: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transactionId,
  });
  return (
    await tokens.generateFromTransaction({
      requestingService: 'RECONCILIATION',
      actorRole: 'auditor',
      actorId: 'usr-auditor',
      transactionId,
      targetService: 'RECONCILIATION',
      purpose: 'INTERNAL_AUDIT',
      subjectType: 'CUSTOMER',
    })
  ).pseudonym;
}

const body = (token: string, over: Record<string, unknown> = {}) => ({
  auditToken: token,
  basis: 'DISPUTE',
  caseRef: 'KASUS-2026-014',
  attributes: ['nama', 'nik'],
  ...over,
});
const request = (token: string, over: Record<string, unknown> = {}, caller: object = AUDITOR) =>
  disclosure.request({ ...caller, ...body(token, over) } as never);
const approve = (id: string, caller: object = ADMIN) =>
  disclosure.approve({ ...caller, disclosureId: id } as never);
const reject = (id: string, caller: object = ADMIN) =>
  disclosure.reject({ ...caller, disclosureId: id } as never);

const rows = async (sql: string, args: unknown[] = []) =>
  (await db.owner.query<Record<string, unknown>>(sql, args)).rows;
const requests = () => rows('SELECT * FROM disclosure_request ORDER BY created_at, id');
const auditOf = (action: string) =>
  rows('SELECT * FROM audit_log WHERE action = $1 ORDER BY created_at, id', [action]);
const statusOf = async (id: string): Promise<unknown> =>
  (await rows('SELECT status FROM disclosure_request WHERE id = $1', [id]))[0]?.['status'];

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}
async function pending(): Promise<string> {
  return (await request(await issueP7())).disclosureId;
}

describe('M3-04 FR-09 POST /disclosure-requests (spec privacy 4.10)', () => {
  it('M3-04 FR-09 an auditor opens a PENDING request on the P7 token, with one audit row that names attributes, not values', async () => {
    const token = await issueP7();
    const result = await request(token);
    expect(result.status).toBe('PENDING');
    const [row] = await requests();
    expect(row).toMatchObject({
      id: result.disclosureId,
      basis: 'DISPUTE',
      case_ref: 'KASUS-2026-014',
      requested_attrs: ['nama', 'nik'],
      requester_id: 'usr-auditor',
      approver_id: null,
      status: 'PENDING',
      decided_at: null,
      expires_at: null,
      used_at: null,
    });
    const audit = await auditOf('DISCLOSURE_REQUESTED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'SUCCESS',
      reason: 'OK',
      requesting_service: 'ADMIN_CONSOLE',
      actor_id: 'usr-auditor',
      pseudonym: token,
      disclosure_id: result.disclosureId,
      attribute_names: ['nama', 'nik'],
    });
    expect(JSON.stringify(audit)).not.toContain('KASUS-2026-014');
    expect(JSON.stringify(audit)).not.toContain(CUSTOMER);
  });

  it('M3-04 TK-27 K-07 an invalid basis is refused with no request row and one DENIED audit row without names', async () => {
    const token = await issueP7();
    expect(await reasonOf(request(token, { basis: 'CURIOSITY' }))).toBe('INVALID_BASIS');
    expect(await requests()).toHaveLength(0);
    const audit = await auditOf('DISCLOSURE_REQUESTED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'DENIED',
      reason: 'INVALID_BASIS',
      mapping_id: null,
      disclosure_id: null,
      attribute_names: null,
    });
  });

  it.each([['hp'], ['rekening'], ['email'], ['nama,x']])(
    'M3-04 TK-27 K-07 the attribute %s is refused: no row, one DENIED row, the bad name is not stored',
    async (name) => {
      const token = await issueP7();
      expect(await reasonOf(request(token, { attributes: ['nama', name] }))).toBe(
        'ATTRIBUTE_NOT_ALLOWED',
      );
      expect(await requests()).toHaveLength(0);
      const audit = await auditOf('DISCLOSURE_REQUESTED');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        status: 'DENIED',
        reason: 'ATTRIBUTE_NOT_ALLOWED',
        attribute_names: null,
      });
    },
  );

  it('M3-04 TK-27 an empty attribute list is refused, and a wrong basis wins over a wrong attribute', async () => {
    const token = await issueP7();
    expect(await reasonOf(request(token, { attributes: [] }))).toBe('ATTRIBUTE_NOT_ALLOWED');
    expect(await reasonOf(request(token, { basis: 'X', attributes: ['hp'] }))).toBe(
      'INVALID_BASIS',
    );
    expect(await requests()).toHaveLength(0);
  });

  it('M3-04 FR-09 the token must be an active P7 token of RECONCILIATION: each other case is refused, one DENIED row, no request', async () => {
    const p7 = await issueP7();
    const p1 = (
      await rows("SELECT pseudonym FROM pseudonym_mapping WHERE service_id = 'TRANSACTION'")
    )[0]?.['pseudonym'] as string;
    const p6 = (
      await tokens.generate({
        requestingService: 'API_GATEWAY',
        subjectType: 'ACCOUNT',
        subjectId: '1234567801',
        targetService: 'RECONCILIATION',
        purpose: 'DAILY_RECONCILIATION',
      })
    ).pseudonym;
    expect(await reasonOf(request('PSEU-00000000'))).toBe('TOKEN_NOT_FOUND');
    expect(await reasonOf(request(p1))).toBe('SERVICE_MISMATCH');
    expect(await reasonOf(request(p6))).toBe('PURPOSE_MISMATCH');
    await db.owner.query("UPDATE pseudonym_mapping SET status = 'revoked' WHERE pseudonym = $1", [
      p7,
    ]);
    expect(await reasonOf(request(p7))).toBe('REVOKED');
    await db.owner.query("UPDATE pseudonym_mapping SET status = 'expired' WHERE pseudonym = $1", [
      p7,
    ]);
    expect(await reasonOf(request(p7))).toBe('EXPIRED');
    expect(await requests()).toHaveLength(0);
    const audit = await auditOf('DISCLOSURE_REQUESTED');
    expect(audit.map((row) => row['reason'])).toEqual([
      'TOKEN_NOT_FOUND',
      'SERVICE_MISMATCH',
      'PURPOSE_MISMATCH',
      'REVOKED',
      'EXPIRED',
    ]);
  });

  it('M3-04 TK-25 AZ-10 N2 only an auditor behind the admin console: an admin is FORBIDDEN_ROLE, a service POLICY_NOT_ALLOWED', async () => {
    const token = await issueP7();
    expect(await reasonOf(request(token, {}, ADMIN))).toBe('FORBIDDEN_ROLE');
    expect(await reasonOf(request(token, {}, { ...AUDITOR, actorRole: undefined }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(
      await reasonOf(request(token, {}, { ...AUDITOR, requestingService: 'RECONCILIATION' })),
    ).toBe('POLICY_NOT_ALLOWED');
    expect(await requests()).toHaveLength(0);
    expect(await auditOf('DISCLOSURE_REQUESTED')).toHaveLength(3);
  });

  it.each([
    ['a case reference in lower case', { caseRef: 'kasus-1' }],
    ['a case reference that is too long', { caseRef: 'K'.repeat(65) }],
    ['attributes that are not a list', { attributes: 'nama' }],
    ['an attribute that is not text', { attributes: [1] }],
    ['a repeated attribute', { attributes: ['nama', 'nama'] }],
    ['a token that is not a pseudonym', { auditToken: 'nope' }],
  ])('M3-04 K-07 %s is a 422 of shape: not audited, no row', async (_name, over) => {
    const token = await issueP7();
    expect(await reasonOf(request(token, over))).toBe('VALIDATION_ERROR');
    expect(await requests()).toHaveLength(0);
    expect(await auditOf('DISCLOSURE_REQUESTED')).toHaveLength(0);
  });
});

describe('M3-04 FR-09 TK-24 approve (four eyes, 600 s)', () => {
  it('M3-04 FR-09 an admin approves: APPROVED, who and when, valid for the configured seconds, one audit row', async () => {
    const id = await pending();
    clock.advance(30);
    const result = await approve(id);
    expect(result).toEqual({
      disclosureId: id,
      status: 'APPROVED',
      expiresAt: new Date(clock.now().getTime() + APPROVAL_TTL * 1000),
    });
    expect((await requests())[0]).toMatchObject({
      status: 'APPROVED',
      approver_id: 'usr-admin',
      requester_id: 'usr-auditor',
      decided_at: clock.now(),
      expires_at: result.expiresAt,
      used_at: null,
    });
    const audit = await auditOf('DISCLOSURE_APPROVED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'SUCCESS',
      reason: 'OK',
      actor_id: 'usr-admin',
      disclosure_id: id,
      attribute_names: ['nama', 'nik'],
    });
  });

  it('M3-04 TK-24 the requester approving their own request is SELF_APPROVAL, the request stays PENDING, one DENIED row', async () => {
    const id = await pending();
    expect(await reasonOf(approve(id, { ...ADMIN, actorId: 'usr-auditor' }))).toBe('SELF_APPROVAL');
    expect(await statusOf(id)).toBe('PENDING');
    const audit = await auditOf('DISCLOSURE_APPROVED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'DENIED',
      reason: 'SELF_APPROVAL',
      actor_id: 'usr-auditor',
      disclosure_id: id,
    });
  });

  it('M3-04 TK-24 the database refuses the same person on both sides too (chk_four_eyes), as the real role', async () => {
    const id = await pending();
    await expect(
      db.app.query(
        "UPDATE disclosure_request SET status = 'APPROVED', approver_id = requester_id, decided_at = now() WHERE id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await statusOf(id)).toBe('PENDING');
  });

  it('M3-04 TK-25 AZ-11 N2 an auditor is FORBIDDEN_ROLE, a service POLICY_NOT_ALLOWED; the request stays PENDING', async () => {
    const id = await pending();
    expect(await reasonOf(approve(id, AUDITOR))).toBe('FORBIDDEN_ROLE');
    expect(await reasonOf(approve(id, { ...ADMIN, requestingService: 'RECONCILIATION' }))).toBe(
      'POLICY_NOT_ALLOWED',
    );
    expect(await statusOf(id)).toBe('PENDING');
    expect(await auditOf('DISCLOSURE_APPROVED')).toHaveLength(2);
  });

  it('M3-04 K-01 an unknown request is DISCLOSURE_NOT_FOUND (audited, no disclosure id)', async () => {
    expect(await reasonOf(approve('00000000-0000-4000-8000-000000000000'))).toBe(
      'DISCLOSURE_NOT_FOUND',
    );
    const audit = await auditOf('DISCLOSURE_APPROVED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'DENIED',
      reason: 'DISCLOSURE_NOT_FOUND',
      disclosure_id: null,
    });
  });

  it('M3-04 C-09 K-01 approving twice: the second is DISCLOSURE_NOT_PENDING and changes nothing', async () => {
    const id = await pending();
    const first = await approve(id);
    clock.advance(5);
    expect(await reasonOf(approve(id, ADMIN_TWO))).toBe('DISCLOSURE_NOT_PENDING');
    expect((await requests())[0]).toMatchObject({
      approver_id: 'usr-admin',
      expires_at: first.expiresAt,
    });
  });

  it.each(['APPROVED', 'USED', 'REJECTED', 'EXPIRED'])(
    'M3-04 C-09 a request that is %s cannot be approved or rejected: DISCLOSURE_NOT_PENDING, status unchanged',
    async (status) => {
      const id = await pending();
      await db.owner.query(
        `UPDATE disclosure_request SET status = $2, approver_id = 'usr-admin-two', decided_at = now(),
                expires_at = now() + interval '10 minutes' WHERE id = $1`,
        [id, status],
      );
      expect(await reasonOf(approve(id))).toBe('DISCLOSURE_NOT_PENDING');
      expect(await reasonOf(reject(id))).toBe('DISCLOSURE_NOT_PENDING');
      expect(await statusOf(id)).toBe(status);
    },
  );

  it('M3-04 TK-26 an approval is valid until decided_at plus the configured seconds, and the clock decides, not the caller', async () => {
    const id = await pending();
    clock.advance(100);
    const { expiresAt } = await approve(id);
    expect(expiresAt.toISOString()).toBe('2026-10-20T08:11:40.000Z');
    clock.advance(601);
    expect(clock.now().getTime()).toBeGreaterThan(expiresAt.getTime());
    // Expiry is judged when the approval is used (M3-05); a late approve of the same request is still a second decision.
    expect(await reasonOf(approve(id, ADMIN_TWO))).toBe('DISCLOSURE_NOT_PENDING');
  });

  /**
   * Holds the row of the request, starts both deciders, waits (pg_locks, no sleep) until both are queued behind the
   * holder, then releases. Without the wait a decider could finish before the other starts and the race would not be
   * tested; the lock being on the row read is what makes the second see the first's decision.
   */
  async function decidedTogether(
    id: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) {
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM disclosure_request WHERE id = $1 FOR UPDATE', [id]);
      const outcomes = Promise.all([reasonOf(first()), reasonOf(second())]);
      let queued = false;
      for (let polls = 0; polls < 5000 && !queued; polls += 1) {
        const { rows } = await db.owner.query<{ n: string }>(
          "SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')",
        );
        queued = Number(rows[0]?.n) >= 2;
      }
      expect(queued).toBe(true);
      await holder.query('COMMIT');
      return await outcomes;
    } finally {
      holder.release();
    }
  }

  it('M3-04 TK-24 two admins approving at once: exactly one wins, the other is DISCLOSURE_NOT_PENDING', async () => {
    const id = await pending();
    const outcomes = await decidedTogether(
      id,
      () => approve(id, ADMIN),
      () => approve(id, ADMIN_TWO),
    );
    expect([...outcomes].sort()).toEqual(['DISCLOSURE_NOT_PENDING', 'no error']);
    expect(await statusOf(id)).toBe('APPROVED');
    expect(
      (await auditOf('DISCLOSURE_APPROVED')).filter((row) => row['status'] === 'SUCCESS'),
    ).toHaveLength(1);
  });

  it('M3-04 C-09 an approve and a reject at once: one decision stands', async () => {
    const id = await pending();
    const outcomes = await decidedTogether(
      id,
      () => approve(id),
      () => reject(id, ADMIN_TWO),
    );
    expect([...outcomes].sort()).toEqual(['DISCLOSURE_NOT_PENDING', 'no error']);
    expect(['APPROVED', 'REJECTED']).toContain(await statusOf(id));
  });

  it('M3-04 a malformed request id is a 422 of shape and is not audited', async () => {
    expect(await reasonOf(approve('not-a-uuid'))).toBe('VALIDATION_ERROR');
    expect(await auditOf('DISCLOSURE_APPROVED')).toHaveLength(0);
  });
});

describe('M3-04 AZ-12 reject', () => {
  it('M3-04 FR-09 an admin rejects: REJECTED with the decision time, one audit row, and it cannot be approved afterwards', async () => {
    const id = await pending();
    clock.advance(10);
    expect(await reject(id)).toEqual({ disclosureId: id, status: 'REJECTED' });
    expect((await requests())[0]).toMatchObject({
      status: 'REJECTED',
      decided_at: clock.now(),
      expires_at: null,
    });
    const audit = await auditOf('DISCLOSURE_REJECTED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 'SUCCESS', actor_id: 'usr-admin', disclosure_id: id });
    expect(await reasonOf(approve(id, ADMIN_TWO))).toBe('DISCLOSURE_NOT_PENDING');
  });

  it('M3-04 TK-25 AZ-12 N2 an auditor is FORBIDDEN_ROLE, a service POLICY_NOT_ALLOWED; an unknown id is DISCLOSURE_NOT_FOUND', async () => {
    const id = await pending();
    expect(await reasonOf(reject(id, AUDITOR))).toBe('FORBIDDEN_ROLE');
    expect(await reasonOf(reject(id, { ...ADMIN, requestingService: 'FRAUD' }))).toBe(
      'POLICY_NOT_ALLOWED',
    );
    expect(await reasonOf(reject('00000000-0000-4000-8000-000000000000'))).toBe(
      'DISCLOSURE_NOT_FOUND',
    );
    expect(await statusOf(id)).toBe('PENDING');
    expect(await auditOf('DISCLOSURE_REJECTED')).toHaveLength(3);
  });
});
