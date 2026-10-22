import { join } from 'node:path';
import { DomainError, FakeClock, loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import { AuditWriter, AuditedOperation } from '../src/audit';
import { BlindIndex, FieldCipher, TokenMint, createKeys } from '../src/crypto';
import { IdentityVault } from '../src/identity';
import { PolicyEngine } from '../src/policy';
import { RevocationService } from '../src/revocation';
import { TokenService } from '../src/token';

// Seam: RevocationService (revoke one token, revoke a subject) on the real privacy database, as the real runtime role,
// with a FakeClock; tokens are made and used through TokenService, the vault through IdentityVault. Every value is
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
const CUSTOMER = 'CUST-000101';
const OTHER = 'CUST-000102';
const ACCOUNT = '1234567801';
const ADMIN = { requestingService: 'ADMIN_CONSOLE', actorId: 'usr-admin', actorRole: 'admin' };

let db: TestDb;
let clock: FakeClock;
let tokens: TokenService;
let vault: IdentityVault;
let revocation: RevocationService;

beforeEach(async () => {
  db = await createTestDb(config, { service: 'privacy', suffix: 'm302' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  clock = new FakeClock('2026-10-20T08:00:00.000Z');
  const operation = new AuditedOperation(db.app, new AuditWriter());
  const index = new BlindIndex(keys);
  const cipher = new FieldCipher(keys);
  tokens = new TokenService({
    operation,
    policy: new PolicyEngine(TTL),
    index,
    cipher,
    mint: new TokenMint(keys),
    clock,
    graceSeconds: 30,
    keyVersion: 1,
  });
  vault = new IdentityVault({ operation, index, cipher, clock, keyVersion: 1 });
  revocation = new RevocationService({ operation, index, vault, clock });
});
afterEach(async () => {
  await db.close();
});

const p1 = async (customer = CUSTOMER, transactionId = 'TX-8001'): Promise<string> =>
  (
    await tokens.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'CUSTOMER',
      subjectId: customer,
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId,
    })
  ).pseudonym;
const p4 = async (source: string, transactionId = 'TX-8001'): Promise<string> =>
  (
    await tokens.exchange({
      requestingService: 'TRANSACTION',
      sourcePseudonym: source,
      targetService: 'NOTIFICATION',
      purpose: 'NOTIFICATION',
      transactionId,
    })
  ).pseudonym;
const p5 = async (customer = CUSTOMER): Promise<string> =>
  (
    await tokens.generate({
      requestingService: 'API_GATEWAY',
      subjectType: 'CUSTOMER',
      subjectId: customer,
      targetService: 'NOTIFICATION',
      purpose: 'NOTIFICATION_REGISTRATION',
    })
  ).pseudonym;
const store = (customer = CUSTOMER) =>
  vault.store({
    requestingService: 'API_GATEWAY',
    customerId: customer,
    nik: '9999000011112222',
    nama: 'Budi Contoh Palsu',
    hp: '081200000001',
    rekening: '99990000000001',
  });

const revokeToken = (pseudonym: string, over: Record<string, unknown> = {}) =>
  revocation.revokeToken({ ...ADMIN, pseudonym, ...over });
const revokeSubject = (subjectId: string, over: Record<string, unknown> = {}) =>
  revocation.revokeSubject({ ...ADMIN, subjectType: 'CUSTOMER', subjectId, ...over });

const rows = async (sql: string, args: unknown[] = []) =>
  (await db.owner.query<Record<string, unknown>>(sql, args)).rows;
const auditOf = (action: string) =>
  rows('SELECT * FROM audit_log WHERE action = $1 ORDER BY created_at, id', [action]);
const mapping = async (pseudonym: string) =>
  (await rows('SELECT * FROM pseudonym_mapping WHERE pseudonym = $1', [pseudonym]))[0];
const count = async (table: string): Promise<number> =>
  Number((await rows(`SELECT count(*) AS n FROM ${table}`))[0]?.['n']);

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.reason : 'not a DomainError';
  }
  return 'no error';
}

describe('M3-02 FR-12 TK-04 K-11 revoke one token (spec privacy 4.5)', () => {
  it('M3-02 FR-12 revokes with revoked_at, one SUCCESS row by the admin, and the row stays', async () => {
    const token = await p1();
    const before = await count('pseudonym_mapping');
    const result = await revokeToken(token);
    expect(result).toEqual({ pseudonym: token, revokedAt: clock.now() });
    expect(await mapping(token)).toMatchObject({ status: 'revoked', revoked_at: clock.now() });
    expect(await count('pseudonym_mapping')).toBe(before);
    const audit = await auditOf('REVOKE_TOKEN');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'SUCCESS',
      reason: 'OK',
      requesting_service: 'ADMIN_CONSOLE',
      actor_id: 'usr-admin',
      pseudonym: token,
      purpose: 'PAYMENT_PROCESSING',
    });
  });

  it('M3-02 TK-04 FR-12 the next use is REVOKED (exchange, and resolve-domain for a notification token)', async () => {
    const source = await p1();
    const notif = await p4(source);
    await p5();
    await revokeToken(source);
    await revokeToken(notif);
    expect(
      await reasonOf(
        tokens.exchange({
          requestingService: 'TRANSACTION',
          sourcePseudonym: source,
          targetService: 'FRAUD',
          purpose: 'FRAUD_DETECTION',
          transactionId: 'TX-8001',
        }),
      ),
    ).toBe('REVOKED');
    expect(
      await reasonOf(
        tokens.resolveDomain({ requestingService: 'NOTIFICATION', notifToken: notif }),
      ),
    ).toBe('REVOKED');
  });

  it('M3-02 FR-12 is idempotent: the same answer and the first revoked_at, one row per call', async () => {
    const token = await p1();
    const first = await revokeToken(token);
    clock.advance(60);
    const second = await revokeToken(token);
    expect(second).toEqual(first);
    expect((await mapping(token))?.['revoked_at']).toEqual(first.revokedAt);
    const audit = await auditOf('REVOKE_TOKEN');
    expect(audit.map((row) => [row['status'], row['reason']])).toEqual([
      ['SUCCESS', 'OK'],
      ['SUCCESS', 'OK'],
    ]);
  });

  it('M3-02 K-11 a token that expired can be revoked, stored as expired or only by time', async () => {
    const stored = await p1();
    await db.owner.query("UPDATE pseudonym_mapping SET status = 'expired' WHERE pseudonym = $1", [
      stored,
    ]);
    const byTime = await p1(OTHER, 'TX-8002');
    clock.advance(10_000);
    await revokeToken(stored);
    await revokeToken(byTime);
    expect(await mapping(stored)).toMatchObject({ status: 'revoked' });
    expect(await mapping(byTime)).toMatchObject({ status: 'revoked' });
  });

  it('M3-02 FR-12 TOKEN_NOT_FOUND is DENIED with one row', async () => {
    expect(await reasonOf(revokeToken('PSEU-00000000'))).toBe('TOKEN_NOT_FOUND');
    const audit = await auditOf('REVOKE_TOKEN');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: 'DENIED',
      reason: 'TOKEN_NOT_FOUND',
      pseudonym: 'PSEU-00000000',
      actor_id: 'usr-admin',
    });
  });

  it.each([
    [
      'a service that is not the admin console',
      { requestingService: 'TRANSACTION' },
      'POLICY_NOT_ALLOWED',
    ],
    ['the admin console without a role', { actorRole: undefined }, 'FORBIDDEN_ROLE'],
    ['an auditor', { actorRole: 'auditor' }, 'FORBIDDEN_ROLE'],
    ['a fraud analyst', { actorRole: 'fraud_analyst' }, 'FORBIDDEN_ROLE'],
  ])(
    'M3-02 AZ-16 N2 %s is %s: one DENIED row, the token untouched',
    async (_name, over, reason) => {
      const token = await p1();
      expect(await reasonOf(revokeToken(token, over))).toBe(reason);
      const audit = await auditOf('REVOKE_TOKEN');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ status: 'DENIED', reason });
      expect(await mapping(token)).toMatchObject({ status: 'active', revoked_at: null });
    },
  );

  it('M3-02 AZ-16 a caller that is not the admin console learns nothing about which tokens exist', async () => {
    const real = await reasonOf(revokeToken(await p1(), { requestingService: 'FRAUD' }));
    const none = await reasonOf(revokeToken('PSEU-00000000', { requestingService: 'FRAUD' }));
    expect([real, none]).toEqual(['POLICY_NOT_ALLOWED', 'POLICY_NOT_ALLOWED']);
  });

  it('M3-02 a malformed pseudonym is a 422 and is not audited (spec privacy 9.4)', async () => {
    expect(await reasonOf(revokeToken('not-a-token'))).toBe('VALIDATION_ERROR');
    expect(await count('audit_log')).toBe(0);
  });
});

describe('M3-02 FR-29 FR-44 TK-17 revoke a subject (spec privacy 4.6)', () => {
  async function subjectWithEverything() {
    await store();
    const source = await p1();
    const notif = await p4(source);
    const domain = await p5();
    return { source, notif, domain };
  }

  it('M3-02 TK-17 FR-29 revokes every active token, one row each, then the next use is REVOKED', async () => {
    const { source, notif, domain } = await subjectWithEverything();
    const other = await p1(OTHER, 'TX-8002');
    await store(OTHER);
    const result = await revokeSubject(CUSTOMER);
    expect(result).toEqual({ revokedCount: 3 });
    for (const token of [source, notif, domain]) {
      expect(await mapping(token)).toMatchObject({ status: 'revoked', revoked_at: clock.now() });
    }
    expect(await mapping(other)).toMatchObject({ status: 'active' });

    const audit = await auditOf('REVOKE_SUBJECT');
    expect(audit.map((row) => row['mapping_id']).sort()).toEqual(
      (
        await Promise.all([source, notif, domain].map(async (t) => (await mapping(t))?.['id']))
      ).sort(),
    );
    expect(
      audit.every((row) => row['status'] === 'SUCCESS' && row['actor_id'] === 'usr-admin'),
    ).toBe(true);

    expect(
      await reasonOf(
        tokens.exchange({
          requestingService: 'TRANSACTION',
          sourcePseudonym: source,
          targetService: 'FRAUD',
          purpose: 'FRAUD_DETECTION',
          transactionId: 'TX-8001',
        }),
      ),
    ).toBe('REVOKED');
  });

  it('M3-02 FR-44 the vault is emptied together with purged_at and one PURGE_IDENTITY row; the other customer keeps theirs', async () => {
    await subjectWithEverything();
    await store(OTHER);
    await revokeSubject(CUSTOMER);
    const vaults = await rows('SELECT * FROM identity_vault ORDER BY created_at, id');
    expect(vaults).toHaveLength(2);
    const [emptied, kept] = vaults.sort((a) => (a['purged_at'] === null ? 1 : -1));
    for (const column of [
      'customer_lookup',
      'customer_id_enc',
      'nik_enc',
      'nama_enc',
      'hp_enc',
      'rekening_enc',
    ]) {
      expect(emptied?.[column]).toBeNull();
    }
    expect(emptied?.['purged_at']).toEqual(clock.now());
    expect(kept?.['purged_at']).toBeNull();
    expect(kept?.['customer_lookup']).not.toBeNull();

    const purge = await auditOf('PURGE_IDENTITY');
    expect(purge).toHaveLength(1);
    expect(purge[0]).toMatchObject({
      status: 'SUCCESS',
      reason: 'OK',
      requesting_service: 'ADMIN_CONSOLE',
      actor_id: 'usr-admin',
      mapping_id: null,
      pseudonym: null,
    });
  });

  it('M3-02 FR-29 a subject with a vault row and no token: count 0, PURGE_IDENTITY, no DENIED row', async () => {
    await store();
    expect(await revokeSubject(CUSTOMER)).toEqual({ revokedCount: 0 });
    expect(await auditOf('REVOKE_SUBJECT')).toHaveLength(0);
    expect(await auditOf('PURGE_IDENTITY')).toHaveLength(1);
  });

  it('M3-02 TK-17 a subject with nothing: 0 and exactly one DENIED TOKEN_NOT_FOUND row', async () => {
    expect(await revokeSubject(CUSTOMER)).toEqual({ revokedCount: 0 });
    expect(await count('audit_log')).toBe(1);
    expect((await auditOf('REVOKE_SUBJECT'))[0]).toMatchObject({
      status: 'DENIED',
      reason: 'TOKEN_NOT_FOUND',
      requesting_service: 'ADMIN_CONSOLE',
      actor_id: 'usr-admin',
      mapping_id: null,
    });
  });

  it('M3-02 FR-29 repeating it finds nothing left: 0 and one DENIED row, no second PURGE_IDENTITY', async () => {
    await subjectWithEverything();
    await revokeSubject(CUSTOMER);
    expect(await revokeSubject(CUSTOMER)).toEqual({ revokedCount: 0 });
    expect(await auditOf('PURGE_IDENTITY')).toHaveLength(1);
    expect(
      (await auditOf('REVOKE_SUBJECT')).filter((row) => row['status'] === 'DENIED'),
    ).toHaveLength(1);
  });

  it('M3-02 FR-29 an account has no vault: its tokens are revoked and nothing is purged', async () => {
    const token = (
      await tokens.generate({
        requestingService: 'API_GATEWAY',
        subjectType: 'ACCOUNT',
        subjectId: ACCOUNT,
        targetService: 'TRANSACTION',
        purpose: 'PAYMENT_PROCESSING',
        transactionId: 'TX-8003',
      })
    ).pseudonym;
    const result = await revocation.revokeSubject({
      ...ADMIN,
      subjectType: 'ACCOUNT',
      subjectId: ACCOUNT,
    });
    expect(result).toEqual({ revokedCount: 1 });
    expect(await mapping(token)).toMatchObject({ status: 'revoked' });
    expect(await auditOf('PURGE_IDENTITY')).toHaveLength(0);
  });

  it('M3-02 FR-29 a token that already expired or was revoked is not counted', async () => {
    const old = await p1(CUSTOMER, 'TX-8004');
    await revokeToken(old);
    const alive = await p5();
    expect(await revokeSubject(CUSTOMER)).toEqual({ revokedCount: 1 });
    expect(await mapping(alive)).toMatchObject({ status: 'revoked' });
  });

  it.each([
    [
      'a service that is neither the admin console nor the Gateway',
      { requestingService: 'TRANSACTION' },
      'POLICY_NOT_ALLOWED',
    ],
    ['an auditor', { actorRole: 'auditor' }, 'FORBIDDEN_ROLE'],
    ['no role', { actorRole: undefined }, 'FORBIDDEN_ROLE'],
  ])('M3-02 AZ-17 N2 %s is %s: one DENIED row, nothing changed', async (_name, over, reason) => {
    const { source } = await subjectWithEverything();
    expect(await reasonOf(revokeSubject(CUSTOMER, over))).toBe(reason);
    const audit = await auditOf('REVOKE_SUBJECT');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 'DENIED', reason });
    expect(await mapping(source)).toMatchObject({ status: 'active' });
    expect(await auditOf('PURGE_IDENTITY')).toHaveLength(0);
    expect((await rows('SELECT purged_at FROM identity_vault'))[0]?.['purged_at']).toBeNull();
  });

  it.each([
    ['a customer id of the wrong shape', { subjectId: 'CUST-1' }],
    ['an unknown subject type', { subjectType: 'MERCHANT' }],
  ])('M3-02 %s is a 422 and is not audited', async (_name, over) => {
    expect(await reasonOf(revokeSubject(CUSTOMER, over))).toBe('VALIDATION_ERROR');
    expect(await count('audit_log')).toBe(0);
  });

  it('M3-02 FR-15 no audit row carries the subject id', async () => {
    await subjectWithEverything();
    await revokeSubject(CUSTOMER);
    expect(JSON.stringify(await rows('SELECT * FROM audit_log'))).not.toContain(CUSTOMER);
  });

  it('M3-02 K-33 two revocations of one subject at once: every token revoked once, one purge, no deadlock', async () => {
    const { source, notif, domain } = await subjectWithEverything();
    const [a, b] = await Promise.all([revokeSubject(CUSTOMER), revokeSubject(CUSTOMER)]);
    expect(a.revokedCount + b.revokedCount).toBe(3);
    for (const token of [source, notif, domain]) {
      expect(await mapping(token)).toMatchObject({ status: 'revoked' });
    }
    expect(await auditOf('PURGE_IDENTITY')).toHaveLength(1);
    expect(
      (await auditOf('REVOKE_SUBJECT')).filter((row) => row['status'] === 'SUCCESS'),
    ).toHaveLength(3);
  });
});

describe('M4-08 ADR-0014 the Gateway may revoke a customer subject, as the compensation of a registration', () => {
  const GATEWAY = { requestingService: 'API_GATEWAY' };

  it('M4-08 ADR-0014 the Gateway empties the vault and revokes the tokens of a CUSTOMER; the audit names the Gateway and no person', async () => {
    await store();
    const token = await p5();
    const result = await revocation.revokeSubject({
      ...GATEWAY,
      subjectType: 'CUSTOMER',
      subjectId: CUSTOMER,
    });
    expect(result).toEqual({ revokedCount: 1 });
    expect(await mapping(token)).toMatchObject({ status: 'revoked' });
    const purged = await auditOf('PURGE_IDENTITY');
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({ requesting_service: 'API_GATEWAY', actor_id: null });
    expect(JSON.stringify(await auditOf('REVOKE_SUBJECT'))).not.toContain(CUSTOMER);
  });

  it('M4-08 ADR-0014 the Gateway cannot revoke an ACCOUNT, nor a single token: POLICY_NOT_ALLOWED, one DENIED row, nothing changed', async () => {
    const token = (
      await tokens.generate({
        requestingService: 'API_GATEWAY',
        subjectType: 'ACCOUNT',
        subjectId: ACCOUNT,
        targetService: 'TRANSACTION',
        purpose: 'PAYMENT_PROCESSING',
        transactionId: 'TX-8010',
      })
    ).pseudonym;
    expect(
      await reasonOf(
        revocation.revokeSubject({ ...GATEWAY, subjectType: 'ACCOUNT', subjectId: ACCOUNT }),
      ),
    ).toBe('POLICY_NOT_ALLOWED');
    expect(await reasonOf(revocation.revokeToken({ ...GATEWAY, pseudonym: token }))).toBe(
      'POLICY_NOT_ALLOWED',
    );
    expect(await mapping(token)).toMatchObject({ status: 'active' });
    expect((await auditOf('REVOKE_SUBJECT')).filter((r) => r['status'] === 'DENIED')).toHaveLength(
      1,
    );
  });
});
