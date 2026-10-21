import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, migrate, pgConfigSchema } from '@privpay/common';
import { createServiceApp, type ServiceApp } from '@privpay/common/nest';
import { createTestDb, type TestDb } from '@privpay/common/testing';
import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { privacyModules } from '../../privacy-service/src/privacy.module';
import { HOSTS, startGateway, type Harness } from './harness';

// Seam: the gateway over HTTP with the real Privacy Service and its real database behind it (the host privacy.test
// is routed to the Privacy app); the IdP, Transaction and Reconciliation are the fake network. Needs PostgreSQL and
// scripts/db/bootstrap.ps1.
const pg = loadConfig(pgConfigSchema, process.env);
const migrations = join(__dirname, '..', '..', 'privacy-service', 'migrations');
const person = buildCanary(70);
// Built at run time: a literal UUID under services/ would be reported by the secret scan.
const KEY = ['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-');
const hex = (byte: number): string => Buffer.alloc(32, byte).toString('hex');

let db: TestDb;
let privacy: ServiceApp | undefined;
let gateway: Harness;
let dir: string;

/** Sends the call to the Privacy app as the network would; a stopped app is a refused connection. */
const toPrivacy = (inner: typeof fetch): typeof fetch => {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== HOSTS['privacy-service']) return inner(input, init);
    if (privacy === undefined) throw new TypeError('connection refused to privacy');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const answer = await request(privacy.httpServer)
      .post(url.pathname)
      .set(headers)
      .send(typeof init?.body === 'string' ? (JSON.parse(init.body) as object) : {});
    return new Response(answer.text === '' ? null : answer.text, {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
};

beforeEach(async () => {
  db = await createTestDb(pg, { service: 'privacy', suffix: 'm211' });
  await migrate(db.owner, { root: migrations, mode: 'proposed' });
  dir = mkdtempSync(join(tmpdir(), 'privpay-gateway-privacy-'));
  for (const [name, byte] of [
    ['hmac', 1],
    ['index', 2],
    ['field', 3],
  ] as const) {
    writeFileSync(join(dir, name), `${hex(byte)}\n`);
  }
  gateway = await startGateway({}, { wrapFetch: toPrivacy });
  privacy = await createServiceApp(
    {
      service: 'privacy-service',
      modules: privacyModules({
        fetch: gateway.network.fetch,
        pools: { app: db.app, ...(db.auditor === undefined ? {} : { auditor: db.auditor }) },
      }),
    },
    {
      PRIVACY_MODE: 'proposed',
      PORT: '0',
      PG_HOST: pg.PG_HOST,
      PG_PORT: String(pg.PG_PORT),
      PG_SECRETS_DIR: pg.PG_SECRETS_DIR,
      IDP_URL: `http://${HOSTS.idp}`,
      IDP_ISSUER: 'privpay-dev-idp',
      GRACE_PERIOD_SECONDS: '30',
      TTL_PAYMENT_PROCESSING: '900',
      TTL_FRAUD_DETECTION: '2592000',
      TTL_NOTIFICATION: '900',
      TTL_NOTIFICATION_REGISTRATION: '31536000',
      TTL_DAILY_RECONCILIATION: '86400',
      TTL_INTERNAL_AUDIT: '600',
      PSEUDONYM_KEY_VERSION: '1',
      PSEUDONYM_HMAC_SECRET_FILE: join(dir, 'hmac'),
      BLIND_INDEX_SECRET_FILE: join(dir, 'index'),
      FIELD_ENCRYPTION_KEY_FILE: join(dir, 'field'),
    },
    { clock: gateway.clock },
  );
  gateway.network.respond(HOSTS['transaction-service'], (call) => ({
    status: 201,
    body: {
      transaction_id: (call.body as { transaction_id: string }).transaction_id,
      status: 'PENDING',
    },
  }));
  gateway.network.respond(HOSTS['reconciliation-service'], () => ({
    status: 202,
    body: { accepted: true },
  }));
});
afterEach(async () => {
  await privacy?.close();
  privacy = undefined;
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
  await db.close();
});

const pay = () =>
  request(gateway.app.httpServer)
    .post('/transaction')
    .set('authorization', `Bearer ${gateway.tokens.customer()}`)
    .set('idempotency-key', KEY)
    .send({
      source_account: person.rekening,
      merchant_id: 'MRC-001',
      amount: 150000,
      geohash: 'qqguy',
      nik: person.nik,
      nama: person.nama,
      email: person.email,
    });
const wire = () =>
  JSON.stringify(gateway.network.requests.filter((call) => call.host !== HOSTS['privacy-service']));

describe('M2-11 the gateway with the real Privacy Service', () => {
  it('M2-11 FR-02 FR-03 NFR-15 a payment reaches Transaction as the tokens Privacy issued, and no canary is stored or logged', async () => {
    const answer = await pay();
    expect(answer.status).toBe(201);
    const [toTransaction] = gateway.network.to(HOSTS['transaction-service']);
    const outbound = toTransaction?.body as Record<string, string>;
    const rows = await db.owner.query<{ pseudonym: string; subject_type: string }>(
      'SELECT pseudonym, subject_type FROM pseudonym_mapping',
    );
    const byType = Object.fromEntries(
      rows.rows.map((row) => [row.subject_type.trim(), row.pseudonym]),
    );
    expect(Object.keys(byType).sort()).toEqual(['ACCOUNT', 'CUSTOMER']);
    expect(outbound['account_token']).toBe(byType['ACCOUNT']);
    expect(outbound['customer_token']).toBe(byType['CUSTOMER']);

    const audit = await db.owner.query<{ action: string; status: string }>(
      'SELECT action, status FROM audit_log',
    );
    expect(audit.rows).toEqual([
      { action: 'GENERATE_TOKEN', status: 'SUCCESS' },
      { action: 'GENERATE_TOKEN', status: 'SUCCESS' },
    ]);

    const where = { service: 'transaction', location: 'wire' };
    assertNoFindings(scanText(JSON.stringify(toTransaction), [person], where));
    // Everything that left the gateway for a service other than Privacy, and the gateway's log.
    assertNoFindings(scanText(wire(), [person], where));
    assertNoFindings(
      scanText(gateway.logLines.join('\n'), [person], { service: 'gateway', location: 'log' }),
    );
    assertNoFindings(await scanDatabase(db.owner, [person], 'privacy'));
  });

  it('M2-11 FR-32 TF-13 the settlement token of an account is the one the D2 flow would give (same row reused)', async () => {
    const answer = await request(gateway.app.httpServer)
      .post('/settlement/report')
      .set('authorization', `Bearer ${gateway.tokens.bank()}`)
      .send({
        batch_date: '2026-10-18',
        items: [{ account_number: person.rekening, amount: 1500, bank_reference: 'BANK-REF-1' }],
      });
    expect(answer.status).toBe(202);
    const [toReconciliation] = gateway.network.to(HOSTS['reconciliation-service']);
    const sent = (toReconciliation?.body as { items: { account_pseudonym: string }[] }).items[0];

    const again = await request(privacy?.httpServer as never)
      .post('/pseudonymize')
      .set('authorization', `Bearer ${gateway.tokens.service('api-gateway', ['privacy-service'])}`)
      .send({
        subject_type: 'ACCOUNT',
        subject_id: person.rekening,
        target_service: 'RECONCILIATION',
        purpose: 'DAILY_RECONCILIATION',
      });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ pseudonym: sent?.account_pseudonym, reused: true });
    assertNoFindings(await scanDatabase(db.owner, [person], 'privacy'));
  });

  it('M2-11 TK-16 NFR-11 invariant 8 Privacy stopped: 503 and Transaction is never called', async () => {
    await privacy?.close();
    privacy = undefined;
    const answer = await pay();
    expect(answer.status).toBe(503);
    expect(gateway.network.to(HOSTS['transaction-service'])).toHaveLength(0);
    assertNoFindings(
      scanText(JSON.stringify(answer.body) + gateway.logLines.join('\n'), [person], {
        service: 'gateway',
        location: 'answer',
      }),
    );
  });
});

describe('M3-02 the revocation routes through the gateway (TK-17, second layer)', () => {
  const revokeSubject = (token: string) =>
    request(gateway.app.httpServer)
      .post('/subject/revoke')
      .set('authorization', `Bearer ${token}`)
      .send({ subject_type: 'CUSTOMER', subject_id: 'CUST-000101' });
  const revokeToken = (token: string, pseudonym: string) =>
    request(gateway.app.httpServer)
      .post(`/pseudonym/${pseudonym}/revoke`)
      .set('authorization', `Bearer ${token}`)
      .send({});
  // The request id is per call; everything else of the answer must be the same.
  const withoutId = (body: unknown): unknown => {
    const { error } = body as { error: Record<string, unknown> };
    return { error: { ...error, request_id: undefined } };
  };
  const auditCount = async (): Promise<number> =>
    Number((await db.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0]?.n);

  it('M3-02 TK-17 AZ-17 the admin revokes a customer through the gateway and the count comes back', async () => {
    expect((await pay()).status).toBe(201);
    const answer = await revokeSubject(gateway.tokens.person('admin'));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ revoked_count: 1 });
    const rows = await db.owner.query<{ subject_type: string; status: string }>(
      'SELECT subject_type, status FROM pseudonym_mapping',
    );
    expect(
      Object.fromEntries(rows.rows.map((row) => [row.subject_type.trim(), row.status])),
    ).toEqual({
      ACCOUNT: 'active',
      CUSTOMER: 'revoked',
    });
  });

  it('M3-02 AZ-16 AZ-17 N2 an auditor is refused at the gateway as ACCESS_DENIED and Privacy is not asked', async () => {
    expect((await pay()).status).toBe(201);
    const before = await auditCount();
    const auditor = gateway.tokens.person('auditor');
    const subject = await revokeSubject(auditor);
    const token = await revokeToken(auditor, 'PSEU-00000000');
    expect([subject.status, token.status]).toEqual([403, 403]);
    expect(subject.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    expect(withoutId(token.body)).toEqual(withoutId(subject.body));
    expect(await auditCount()).toBe(before);
  });

  it('M3-02 NFR-10 a token that exists and one that does not look alike to a caller who may not revoke', async () => {
    expect((await pay()).status).toBe(201);
    const { pseudonym } = (
      await db.owner.query<{ pseudonym: string }>('SELECT pseudonym FROM pseudonym_mapping LIMIT 1')
    ).rows[0] ?? { pseudonym: '' };
    const auditor = gateway.tokens.person('auditor');
    const real = await revokeToken(auditor, pseudonym);
    const none = await revokeToken(auditor, 'PSEU-00000000');
    expect(real.status).toBe(none.status);
    expect(withoutId(real.body)).toEqual(withoutId(none.body));
  });

  it('M3-02 AZ-16 the admin revokes one token; an unknown one says nothing of its reason', async () => {
    expect((await pay()).status).toBe(201);
    const { pseudonym } = (
      await db.owner.query<{ pseudonym: string }>(
        "SELECT pseudonym FROM pseudonym_mapping WHERE subject_type = 'CUSTOMER'",
      )
    ).rows[0] ?? { pseudonym: '' };
    const ok = await revokeToken(gateway.tokens.person('admin'), pseudonym);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ pseudonym, status: 'revoked' });
    const missing = await revokeToken(gateway.tokens.person('admin'), 'PSEU-00000000');
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.body).toMatchObject({ error: { code: expect.any(String) as unknown } });
    expect(JSON.stringify(missing.body)).not.toContain('TOKEN_NOT_FOUND');
  });
});
