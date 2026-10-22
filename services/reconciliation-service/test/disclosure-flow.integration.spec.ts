import request from 'supertest';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../tests/pii-scan/scan-database';
import { startStack, type Stack } from './support/stack';

// Seam: the whole way to an identity (spec reconciliation 3.3 and 3.4, flow E) with the Gateway, Privacy and
// Reconciliation all real: the auditor asks for an audit token, asks Privacy for a disclosure, ANOTHER person (an admin)
// approves it, and only then does Reconciliation open it. Every shortcut is tried and must be refused by Privacy, whose
// reason Reconciliation passes on. What was opened is kept nowhere. Only the network, the IdP and Transaction are doubles;
// every value is invented. Needs PostgreSQL and scripts/db/bootstrap.ps1.
const person = buildCanary(53);
const TX = 'TX-10001';
const A_REQUEST = '11111111-1111-4111-8111-111111111111';

let stack: Stack;

beforeEach(async () => {
  stack = await startStack('m407');
  stack.transactions.details.set(TX, { transactionId: TX, amount: 35_000, status: 'COMPLETED' });
  // The identity is in the vault once (A5), and the payment made its P1 (B3), so Privacy has a customer for the transaction.
  const stored = await stack.toPrivacy('api-gateway', '/identity', {
    customer_id: person.customer_id,
    nik: person.nik,
    nama: person.nama,
    hp: person.hp,
    rekening: person.rekening,
  });
  expect(stored.status).toBe(201);
  const p1 = await stack.toPrivacy('api-gateway', '/pseudonymize', {
    subject_type: 'CUSTOMER',
    subject_id: person.customer_id,
    target_service: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    transaction_id: TX,
  });
  expect(p1.status).toBe(200);
});
afterEach(async () => {
  await stack.close();
});

type Role = 'auditor' | 'admin' | 'fraud_analyst';
/** A call through the real Gateway, as a person of the admin console. */
const viaGateway = (role: Role, path: string, body: object, sub?: string) =>
  request(stack.gateway.app.httpServer)
    .post(path)
    .set(
      'authorization',
      `Bearer ${stack.gateway.tokens.person(role, sub === undefined ? {} : { sub })}`,
    )
    .send(body);
/** A call straight to Reconciliation as the Gateway would make it, to see the reason the Gateway hides from clients. */
const direct = (role: Role, path: string, body: object, sub?: string) =>
  request(stack.reconciliation.httpServer)
    .post(path)
    .set(
      'authorization',
      `Bearer ${stack.gateway.tokens.service('api-gateway', ['reconciliation-service'])}`,
    )
    .set('x-actor-token', stack.gateway.tokens.person(role, sub === undefined ? {} : { sub }))
    .send(body);

const auditToken = async (): Promise<string> => {
  const answer = await viaGateway('auditor', '/reconciliation/audit-request', {
    transaction_id: TX,
    reason_code: 'DISPUTE',
  });
  expect(answer.status).toBe(200);
  return (answer.body as { audit_token: string }).audit_token;
};
const requestDisclosure = async (token: string, attributes = ['nama']): Promise<string> => {
  const answer = await viaGateway('auditor', '/disclosure-requests', {
    audit_token: token,
    basis: 'DISPUTE',
    case_ref: 'CASE-2026-0001',
    attributes,
  });
  expect(answer.status).toBe(201);
  return (answer.body as { disclosure_id: string }).disclosure_id;
};
const approve = (id: string) => viaGateway('admin', `/disclosure-requests/${id}/approve`, {});
const reject = (id: string) => viaGateway('admin', `/disclosure-requests/${id}/reject`, {});
const open = (token: string, id: string) =>
  direct('auditor', '/reconciliation/disclosure', { audit_token: token, disclosure_id: id });
const refused = (answer: { status: number; body: unknown }, reason: string) => {
  expect(answer.status).toBeGreaterThanOrEqual(403);
  expect(answer.body).toMatchObject({ error: { reason } });
  expect(JSON.stringify(answer.body)).not.toContain(person.nama);
};
const privacyAudit = async (action: string): Promise<Record<string, unknown>[]> =>
  (
    await stack.privacyDb.owner.query<Record<string, unknown>>(
      'SELECT action, status, reason, requesting_service, actor_id FROM audit_log WHERE action = $1 ORDER BY created_at, id',
      [action],
    )
  ).rows;

describe('M4-07 FR-22 TF-06 the routine audit: a token and the data of the transaction, nothing that names the customer', () => {
  it('M4-07 TK-22 the answer is the P7 token, the amount and the status, and the scan finds no attribute in it', async () => {
    const answer = await viaGateway('auditor', '/reconciliation/audit-request', {
      transaction_id: TX,
      reason_code: 'AMOUNT_MISMATCH',
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      transaction_id: TX,
      audit_token: expect.stringMatching(/^PSEU-[0-9A-F]{8}$/) as string,
      amount: 35_000,
      status: 'COMPLETED',
    });
    assertNoFindings(
      scanText(JSON.stringify(answer.body), [person], {
        service: 'reconciliation',
        location: 'response',
      }),
    );
  });

  it('M4-07 FR-22 one row of audit_requests and one audit row of Privacy per request, with the actor of the token', async () => {
    const before = (await privacyAudit('GENERATE_TOKEN')).length;
    await auditToken();
    const rows = (await stack.reconciliationDb.owner.query('SELECT * FROM audit_requests'))
      .rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transaction_id: TX,
      reason_code: 'DISPUTE',
      actor_id: 'usr-auditor',
    });
    const issued = await privacyAudit('GENERATE_TOKEN');
    expect(issued).toHaveLength(before + 1);
    expect(issued.at(-1)).toMatchObject({
      status: 'SUCCESS',
      requesting_service: 'RECONCILIATION',
      actor_id: 'usr-auditor',
    });
    await auditToken();
    expect(
      (await stack.reconciliationDb.owner.query('SELECT 1 FROM audit_requests')).rowCount,
    ).toBe(2);
    expect(await privacyAudit('GENERATE_TOKEN')).toHaveLength(before + 2);
  });

  it('M4-07 TK-08 the token of an audit cannot be had by an admin or a fraud analyst: Privacy is not asked to issue it', async () => {
    const before = (await privacyAudit('GENERATE_TOKEN')).length;
    for (const role of ['admin', 'fraud_analyst'] as const) {
      const answer = await viaGateway(role, '/reconciliation/audit-request', {
        transaction_id: TX,
        reason_code: 'OTHER',
      });
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    }
    expect(await privacyAudit('GENERATE_TOKEN')).toHaveLength(before);
    expect(
      (await stack.reconciliationDb.owner.query('SELECT 1 FROM audit_requests')).rowCount,
    ).toBe(0);
  });

  it('M4-07 K-02 a transaction that does not exist is refused at the Gateway as ACCESS_DENIED, without a row', async () => {
    const answer = await viaGateway('auditor', '/reconciliation/audit-request', {
      transaction_id: 'TX-99999',
      reason_code: 'OTHER',
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    expect(JSON.stringify(answer.body)).not.toContain('TRANSACTION_NOT_FOUND');
    expect(
      (await stack.reconciliationDb.owner.query('SELECT 1 FROM audit_requests')).rowCount,
    ).toBe(0);
  });
});

describe('M4-07 FR-09 FR-43 TK-21 the only way to an identity: request, approval by another person, then opening', () => {
  it('M4-07 FR-43 the auditor requests, an admin approves, Reconciliation opens: exactly the approved attribute comes back', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token, ['nama']);
    expect((await approve(id)).status).toBe(200);
    const through = await viaGateway('auditor', '/reconciliation/disclosure', {
      audit_token: token,
      disclosure_id: id,
    });
    expect(through.status).toBe(200);
    expect(through.body).toEqual({ attributes: { nama: person.nama } });
    expect(through.headers['cache-control']).toBe('no-store');
    const opened = await privacyAudit('DE_PSEUDONYMIZE');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      status: 'SUCCESS',
      requesting_service: 'RECONCILIATION',
      actor_id: 'usr-auditor',
    });
    expect(JSON.stringify(opened)).not.toContain(person.nama);
  });

  it('M4-07 FR-43 the attributes approved are the attributes opened: two approved are two opened, a third is never there', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token, ['customer_id', 'nik']);
    await approve(id);
    const answer = await open(token, id);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      attributes: { customer_id: person.customer_id, nik: person.nik },
    });
    expect(JSON.stringify(answer.body)).not.toContain(person.nama);
    expect(JSON.stringify(answer.body)).not.toContain(person.hp);
    expect(JSON.stringify(answer.body)).not.toContain(person.rekening);
  });

  it('M4-07 TK-21 no request was ever made: DISCLOSURE_NOT_FOUND', async () => {
    refused(await open(await auditToken(), A_REQUEST), 'DISCLOSURE_NOT_FOUND');
  });

  it('M4-07 TK-21 a request nobody has decided yet is not an approval: DISCLOSURE_NOT_APPROVED', async () => {
    const token = await auditToken();
    refused(await open(token, await requestDisclosure(token)), 'DISCLOSURE_NOT_APPROVED');
  });

  it('M4-07 TK-21 a rejected request opens nothing', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token);
    expect((await reject(id)).status).toBe(200);
    refused(await open(token, id), 'DISCLOSURE_NOT_APPROVED');
  });

  it("M4-07 TK-25 the auditor who asked cannot approve it herself: the role is the admin's, and the request stays PENDING", async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token);
    const self = await viaGateway('auditor', `/disclosure-requests/${id}/approve`, {});
    expect(self.status).toBe(403);
    refused(await open(token, id), 'DISCLOSURE_NOT_APPROVED');
  });

  it('M4-07 TK-26 another auditor cannot use a request somebody else made, even an approved one: REQUESTER_MISMATCH', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token);
    await approve(id);
    refused(
      await direct(
        'auditor',
        '/reconciliation/disclosure',
        { audit_token: token, disclosure_id: id },
        'usr-auditor-2',
      ),
      'REQUESTER_MISMATCH',
    );
  });

  it('M4-07 TK-08 an admin or a fraud analyst cannot open, whatever has been approved: FORBIDDEN_ROLE, Privacy not even asked', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token);
    await approve(id);
    for (const role of ['admin', 'fraud_analyst'] as const) {
      refused(
        await direct(role, '/reconciliation/disclosure', { audit_token: token, disclosure_id: id }),
        'FORBIDDEN_ROLE',
      );
    }
    expect(await privacyAudit('DE_PSEUDONYMIZE')).toEqual([]);
  });

  it("M4-07 TK-21 an approval is for the token that was asked about: another transaction's token does not open it", async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token);
    await approve(id);
    // A token of a customer who is not the one approved.
    const other = await stack.toPrivacy('api-gateway', '/pseudonymize', {
      subject_type: 'CUSTOMER',
      subject_id: buildCanary(54).customer_id,
      target_service: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transaction_id: 'TX-10002',
    });
    expect(other.status).toBe(200);
    stack.transactions.details.set('TX-10002', {
      transactionId: 'TX-10002',
      amount: 9_000,
      status: 'COMPLETED',
    });
    const second = await viaGateway('auditor', '/reconciliation/audit-request', {
      transaction_id: 'TX-10002',
      reason_code: 'OTHER',
    });
    const otherToken = (second.body as { audit_token: string }).audit_token;
    expect(otherToken).not.toBe(token);
    const answer = await open(otherToken, id);
    expect(answer.status).toBeGreaterThanOrEqual(403);
    expect(JSON.stringify(answer.body)).not.toContain(person.nama);
  });

  it('M4-07 TK-21 an approval is used once: the second opening is refused', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token);
    await approve(id);
    expect((await open(token, id)).status).toBe(200);
    refused(await open(token, id), 'DISCLOSURE_NOT_APPROVED');
  });

  it('M4-07 TK-21 an approval lives 600 seconds: at 600 it opens, one second later it does not', async () => {
    const token = await auditToken();
    const early = await requestDisclosure(token);
    await approve(early);
    stack.gateway.clock.advance(600);
    expect((await open(token, early)).status).toBe(200);

    const token2 = await auditToken();
    const late = await requestDisclosure(token2);
    await approve(late);
    stack.gateway.clock.advance(601);
    // The audit token (TTL_INTERNAL_AUDIT, 600 s) ends before the approval it was made for does, so Privacy answers
    // for the token first (`EXPIRED`); either way the identity stays closed and nothing is returned.
    const closed = await open(token2, late);
    expect(closed.status).toBe(410);
    expect(['EXPIRED', 'DISCLOSURE_EXPIRED']).toContain(
      (closed.body as { error: { reason: string } }).error.reason,
    );
    expect(JSON.stringify(closed.body)).not.toContain(person.nama);
  });

  it('M4-07 TK-21 three openings at once of one approval: exactly one gets the identity', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token);
    await approve(id);
    const answers = await Promise.all([open(token, id), open(token, id), open(token, id)]);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    expect(answers.filter((answer) => answer.status >= 403)).toHaveLength(2);
    expect(await privacyAudit('DE_PSEUDONYMIZE')).toHaveLength(3);
  });

  it('M4-07 FR-09 the caller cannot widen what is opened: attributes, purpose and requester in the body are refused', async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token, ['nama']);
    await approve(id);
    for (const extra of [
      { attributes: ['nik'] },
      { purpose: 'DAILY_RECONCILIATION' },
      { requester_id: 'usr-x' },
    ]) {
      const answer = await direct('auditor', '/reconciliation/disclosure', {
        audit_token: token,
        disclosure_id: id,
        ...extra,
      });
      expect(answer.status).toBe(422);
    }
    // Nothing was spent: the approval is still there for the proper call.
    expect((await open(token, id)).status).toBe(200);
  });
});

describe('M4-07 T-14 S-27 FR-43 what was opened is kept nowhere', () => {
  it("M4-07 T-14 not in a table, a log line, a metric or an answer but the auditor's, and not in the clear in Privacy", async () => {
    const token = await auditToken();
    const id = await requestDisclosure(token, ['customer_id', 'nik', 'nama']);
    await approve(id);
    const opened = await viaGateway('auditor', '/reconciliation/disclosure', {
      audit_token: token,
      disclosure_id: id,
    });
    // The control: the auditor does get the values, so a clean scan below is not an empty one.
    expect(JSON.stringify(opened.body)).toContain(person.nama);
    expect(opened.status).toBe(200);

    assertNoFindings(await scanDatabase(stack.reconciliationDb.owner, [person], 'reconciliation'));
    assertNoFindings(await scanDatabase(stack.privacyDb.owner, [person], 'privacy'));
    const audit = await stack.privacyDb.owner.query('SELECT * FROM audit_log');
    assertNoFindings(
      scanText(JSON.stringify(audit.rows), [person], { service: 'privacy', location: 'audit_log' }),
    );
    for (const service of ['privacy', 'reconciliation'] as const) {
      assertNoFindings(
        scanText(stack.logs[service].join('\n'), [person], { service, location: 'log' }),
      );
    }
    const metrics = await request(stack.reconciliation.httpServer).get('/metrics');
    assertNoFindings(
      scanText(metrics.text, [person], { service: 'reconciliation', location: 'metrics' }),
    );
    assertNoFindings(
      scanText(stack.gateway.logLines.join('\n'), [person], {
        service: 'gateway',
        location: 'log',
      }),
    );
  });
});
