import request from 'supertest';
import { buildCanary, type Canary } from '../../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../../tests/pii-scan/scan';
import { scanDatabase } from '../../../../tests/pii-scan/scan-database';
import { startStack, type Host, type Stack } from './stack';

// Seam: POST /register (A1 to A5, ADR-0005, ADR-0014) and POST /notification/register (AZ-02) through the real Gateway,
// with the real dev IdP, Privacy and Notification behind it and the SMS simulator at the end. A step that fails is made
// to fail by a 503 at its path while the rest of the host works, so the compensation can be seen working. The data of
// the people are canaries (tests/pii-scan): where they end is what the scan says. Needs PostgreSQL and bootstrap.ps1.
let stack: Stack;
let counter = 0;

beforeAll(async () => {
  stack = await startStack('m408');
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.reset();
});

interface Person {
  readonly canary: Canary;
  readonly username: string;
}
const newPerson = (): Person => {
  counter += 1;
  return { canary: buildCanary(60 + counter), username: `reg.uji.${String(counter)}` };
};
const form = (person: Person, over: Record<string, unknown> = {}) => ({
  nik: person.canary.nik,
  nama: person.canary.nama,
  hp: person.canary.hp,
  email: person.canary.email,
  rekening: person.canary.rekening,
  username: person.username,
  ...over,
});
const register = (body: unknown) =>
  request(stack.gateway.httpServer)
    .post('/register')
    .send(body as object);
const userExists = async (username: string): Promise<boolean> =>
  (
    await request(stack.apps['idp.test'].httpServer)
      .post('/token')
      .send({ grant_type: 'dev_login', client_id: 'customer-app', username })
  ).status === 200;
const vault = async () =>
  (
    await stack.dbs.privacy.owner.query<{ live: string; total: string }>(
      `SELECT count(*) FILTER (WHERE nik_enc IS NOT NULL) AS live, count(*) AS total FROM identity_vault`,
    )
  ).rows[0];
const contacts = async () =>
  (await stack.dbs.notification.owner.query('SELECT pseudonym, phone FROM contact_registry'))
    .rows as { pseudonym: string; phone: string }[];
const messages = async () =>
  (await request(stack.apps['sms.test'].httpServer).get('/__test/messages')).body as {
    messages: unknown[];
  };

const everywhere = async (canary: Canary): Promise<string[]> => {
  const found: string[] = [];
  const note = (where: string, findings: readonly { attribute: string }[]) =>
    found.push(...findings.map((f) => `${f.attribute}@${where}`));
  const dbs = stack.dbs;
  note('privacy-db', await scanDatabase(dbs.privacy.owner, [canary], 'privacy'));
  note('transaction-db', await scanDatabase(dbs.transaction.owner, [canary], 'transaction'));
  note('fraud-db', await scanDatabase(dbs.fraud.owner, [canary], 'fraud'));
  note('notification-db', await scanDatabase(dbs.notification.owner, [canary], 'notification'));
  note(
    'reconciliation-db',
    await scanDatabase(dbs.reconciliation.owner, [canary], 'reconciliation'),
  );
  for (const host of Object.keys(stack.logs) as (Host | 'gateway')[]) {
    note(
      `log:${host}`,
      scanText(stack.logs[host].join('\n'), [canary], { service: host, location: 'log' }),
    );
    const metrics = await request(stack.apps[host].httpServer).get('/metrics');
    note(
      `metrics:${host}`,
      scanText(metrics.text, [canary], { service: host, location: 'metrics' }),
    );
  }
  const audit = await dbs.privacy.owner.query('SELECT * FROM audit_log');
  note(
    'privacy-audit',
    scanText(JSON.stringify(audit.rows), [canary], { service: 'privacy', location: 'audit' }),
  );
  note(
    'sms',
    scanText(JSON.stringify(await messages()), [canary], { service: 'sms', location: 'messages' }),
  );
  return found.sort();
};

describe('M4-08 TF-01 FR-19 FR-42 the registration, step by step', () => {
  it('M4-08 TF-01 A2, A5, A3, A4 in this order, 201 REGISTERED, and the phone reaches Notification only at the end', async () => {
    const person = newPerson();
    const answer = await register(form(person));
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ status: 'REGISTERED' });
    const steps = stack.calls.filter((call) =>
      /idp.test \/admin\/users|privacy.test \/identity|privacy.test \/pseudonymize|notification.test \/notification\/register/.test(
        call,
      ),
    );
    expect(steps).toEqual([
      'POST idp.test /admin/users',
      'POST privacy.test /identity',
      'POST privacy.test /pseudonymize',
      'POST notification.test /notification/register',
    ]);
    expect(await contacts()).toEqual([
      { pseudonym: expect.stringMatching(/^PSEU-[0-9A-F]{8}$/) as string, phone: person.canary.hp },
    ]);
    expect(await vault()).toEqual({ live: '1', total: '1' });
    expect(await userExists(person.username)).toBe(true);
  });

  it('M4-08 FR-42 D-08 NIK, name and account are in no table in the clear, the phone is only in contact_registry, and the email is nowhere', async () => {
    const person = newPerson();
    expect((await register(form(person))).status).toBe(201);
    // The vault holds them, but as ciphertext: the scan of Privacy finds nothing in the clear (FR-25).
    expect(await everywhere(person.canary)).toEqual(['hp@notification-db']);
    // The control: the scan does find a number where it is, so the rest of the list being empty is not an empty scan.
    expect(
      await scanDatabase(stack.dbs.notification.owner, [person.canary], 'notification'),
    ).toEqual([{ attribute: 'hp', location: 'contact_registry.phone', service: 'notification' }]);
  });

  it('M4-08 FR-19 the answer, and an answer to a refused form, carry nothing of the form', async () => {
    const person = newPerson();
    const ok = await register(form(person));
    const refused = await register(form(newPerson(), { nik: '123' }));
    for (const answer of [ok, refused]) {
      assertNoFindings(
        scanText(JSON.stringify(answer.body), [person.canary], {
          service: 'gateway',
          location: 'response',
        }),
      );
    }
  });
});

describe('M4-08 AZ-01 N3 N4 a form that does not fit is 422 and nothing at all is called', () => {
  const person = () => newPerson();
  it.each([
    ['an unknown field', (p: Person) => form(p, { role: 'admin' })],
    ['a customer id in the form', (p: Person) => form(p, { customer_id: 'CUST-000101' })],
    ['a NIK of 15 digits', (p: Person) => form(p, { nik: '123456789012345' })],
    ['a name with digits', (p: Person) => form(p, { nama: 'Budi 2' })],
    ['a phone not starting 08', (p: Person) => form(p, { hp: '6281200000001' })],
    ['an email that is not one', (p: Person) => form(p, { email: 'budi' })],
    ['an account of 7 digits', (p: Person) => form(p, { rekening: '1234567' })],
    ['a username in capitals', (p: Person) => form(p, { username: 'BUDI.UJI' })],
    ['a username too short', (p: Person) => form(p, { username: 'ab' })],
    ['no username', (p: Person) => ({ ...form(p), username: undefined })],
  ])('M4-08 AZ-01 %s', async (_label, make) => {
    const answer = await register(make(person()));
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(stack.calls).toEqual([]);
  });
});

describe('M4-08 ADR-0005 ADR-0014 a step that fails takes back what was done', () => {
  it('M4-08 A2 the IdP away is 503 and nothing exists anywhere', async () => {
    const person = newPerson();
    stack.down.add('idp.test');
    const answer = await register(form(person));
    stack.down.delete('idp.test');
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(await vault()).toEqual({ live: '0', total: '0' });
    expect(await contacts()).toEqual([]);
  });

  it('M4-08 A5 the vault refusing is 503, the user is removed, no contact, and an emptied vault is what is left', async () => {
    const person = newPerson();
    stack.fail('privacy.test', '/identity');
    const answer = await register(form(person));
    expect(answer.status).toBe(503);
    expect(await userExists(person.username)).toBe(false);
    expect(await contacts()).toEqual([]);
    expect(await vault()).toEqual({ live: '0', total: '0' });
    assertNoFindings(
      scanText(stack.logs.gateway.join('\n'), [person.canary], {
        service: 'gateway',
        location: 'log',
      }),
    );
  });

  it('M4-08 A3 the domain token refused: the vault is emptied (revoke_subject), the user removed, no contact', async () => {
    const person = newPerson();
    stack.fail('privacy.test', '/pseudonymize');
    const answer = await register(form(person));
    expect(answer.status).toBe(503);
    expect(await vault()).toMatchObject({ live: '0' });
    expect(await userExists(person.username)).toBe(false);
    expect(await contacts()).toEqual([]);
    expect(stack.calls).toContain('POST privacy.test /subject/revoke');
    expect(await everywhere(person.canary)).toEqual([]);
  });

  it('M4-08 A4 Notification keeps refusing: retried, then the vault is emptied and the user removed, and the phone was never stored', async () => {
    const person = newPerson();
    stack.fail('notification.test', '/notification/register');
    const answer = await register(form(person));
    expect(answer.status).toBe(503);
    expect(
      stack.calls.filter((c) => c === 'POST notification.test /notification/register'),
    ).toHaveLength(3);
    expect(await vault()).toMatchObject({ live: '0' });
    expect(await userExists(person.username)).toBe(false);
    expect(await contacts()).toEqual([]);
    expect(await everywhere(person.canary)).toEqual([]);
  });

  it('M4-08 A4 NFR-12 a Notification that fails once is retried (upsert, idempotent): 201 and exactly one contact', async () => {
    const person = newPerson();
    stack.fail('notification.test', '/notification/register', 1);
    const answer = await register(form(person));
    expect(answer.status).toBe(201);
    expect(await contacts()).toHaveLength(1);
    expect(await userExists(person.username)).toBe(true);
  });

  it('M4-08 ADR-0005 when the compensation fails too the user is still removed, the answer is 503, and the log names a request id only', async () => {
    const person = newPerson();
    stack.fail('notification.test', '/notification/register');
    stack.fail('privacy.test', '/subject/revoke');
    const answer = await register(form(person));
    expect(answer.status).toBe(503);
    expect(await userExists(person.username)).toBe(false);
    // The known limit: the vault could not be emptied now and keeps the identity until an admin does it.
    expect(await vault()).toMatchObject({ live: '1' });
    const log = stack.logs.gateway.join('\n');
    expect(log).toContain('registration_compensation_failed_vault');
    assertNoFindings(scanText(log, [person.canary], { service: 'gateway', location: 'log' }));
  });
});

describe('M4-08 ADR-0005 the registration is idempotent where it can be and safe where it cannot', () => {
  it('M4-08 the same username again is 422 and the first person is untouched (the compensation never reaches them)', async () => {
    const first = newPerson();
    expect((await register(form(first))).status).toBe(201);
    const second = newPerson();
    const again = await register(form(second, { username: first.username }));
    expect(again.status).toBe(422);
    expect(await vault()).toEqual({ live: '1', total: '1' });
    expect(await contacts()).toHaveLength(1);
    expect(await userExists(first.username)).toBe(true);
    expect(stack.calls.filter((c) => c === 'POST privacy.test /subject/revoke')).toEqual([]);
  });

  it('M4-08 five registrations of one username at once: exactly one is made, four are 422, one vault row, one contact', async () => {
    const people = Array.from({ length: 5 }, () => newPerson());
    const username = 'reg.same.user';
    const answers = await Promise.all(people.map((p) => register(form(p, { username }))));
    expect(answers.filter((a) => a.status === 201)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 422)).toHaveLength(4);
    expect(await vault()).toEqual({ live: '1', total: '1' });
    expect(await contacts()).toHaveLength(1);
  });

  it('M4-08 five different people at once: five users, five vault rows, five contacts, no one mixed with another', async () => {
    const people = Array.from({ length: 5 }, () => newPerson());
    const answers = await Promise.all(people.map((p) => register(form(p))));
    expect(answers.map((a) => a.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await vault()).toEqual({ live: '5', total: '5' });
    const stored = await contacts();
    expect(stored.map((c) => c.phone).sort()).toEqual(people.map((p) => p.canary.hp).sort());
    expect(new Set(stored.map((c) => c.pseudonym)).size).toBe(5);
  });
});

describe('M4-08 AZ-02 POST /notification/register: a customer changes the phone', () => {
  it('M4-08 AZ-02 the customer sets and then changes the phone: one contact, the last phone, the answer says REGISTERED and not the token', async () => {
    const token = await stack.login('customer-app', 'nasabah.uji.101');
    const send = (phone: string) =>
      request(stack.gateway.httpServer)
        .post('/notification/register')
        .set('authorization', `Bearer ${token}`)
        .send({ phone, channel: 'SMS' });
    const first = await send('081200000101');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'REGISTERED' });
    expect((await send('081200000999')).status).toBe(200);
    const stored = await contacts();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.phone).toBe('081200000999');
    expect(JSON.stringify(first.body)).not.toMatch(/PSEU-/);
  });

  it('M4-08 AZ-02 N1 N2 no credential is 401; a person of the console is 403 ACCESS_DENIED; nothing is called downstream', async () => {
    const body = { phone: '081200000101', channel: 'SMS' };
    expect(
      (await request(stack.gateway.httpServer).post('/notification/register').send(body)).status,
    ).toBe(401);
    const admin = await stack.login('admin-console', 'admin.uji.1');
    const denied = await request(stack.gateway.httpServer)
      .post('/notification/register')
      .set('authorization', `Bearer ${admin}`)
      .send(body);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    expect(stack.calls.filter((c) => c.includes('notification.test'))).toEqual([]);
  });

  it.each([
    [
      'a customer id in the body',
      { phone: '081200000101', channel: 'SMS', customer_id: 'CUST-000102' },
    ],
    [
      'a domain token in the body',
      { phone: '081200000101', channel: 'SMS', notification_domain_id: 'PSEU-00000001' },
    ],
    ['a phone of the wrong shape', { phone: '12345', channel: 'SMS' }],
    ['a channel other than SMS', { phone: '081200000101', channel: 'EMAIL' }],
  ])('M4-08 AZ-02 N3 N4 %s is 422 and nothing is called', async (_label, body) => {
    const token = await stack.login('customer-app', 'nasabah.uji.101');
    const answer = await request(stack.gateway.httpServer)
      .post('/notification/register')
      .set('authorization', `Bearer ${token}`)
      .send(body);
    expect(answer.status).toBe(422);
    expect(
      stack.calls.filter((c) => c.includes('notification.test') || c.includes('/pseudonymize')),
    ).toEqual([]);
  });
});
