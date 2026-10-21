import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSeedUsers, SEED_FILE } from '../src/seed';

describe('M1-01 the seed users are fictitious and follow ADR-0007', () => {
  const users = loadSeedUsers(SEED_FILE);
  const count = (role: string): number => users.filter((user) => user.role === role).length;

  it('M1-01 holds 3 customers, 2 admins, 2 auditors, 1 fraud analyst and 1 bank', () => {
    expect([
      count('customer'),
      count('admin'),
      count('auditor'),
      count('fraud_analyst'),
      count('bank'),
    ]).toEqual([3, 2, 2, 1, 1]);
    expect(users).toHaveLength(9);
  });

  it('M1-01 the customers are CUST-000101 to CUST-000103 (PRD 16), and only customers have a customer_id', () => {
    const customers = users.filter((user) => user.role === 'customer');
    expect(customers.map((user) => user.customer_id)).toEqual([
      'CUST-000101',
      'CUST-000102',
      'CUST-000103',
    ]);
    for (const user of users.filter((u) => u.role !== 'customer')) {
      expect(user.customer_id).toBeUndefined();
    }
  });

  it('M1-01 every human has exactly one role and ids and usernames are unique', () => {
    for (const user of users) expect(typeof user.role).toBe('string');
    expect(new Set(users.map((user) => user.id)).size).toBe(users.length);
    expect(new Set(users.map((user) => user.username)).size).toBe(users.length);
  });

  it('M1-01 every username says it is a test account, and no field holds anything but id, username, role, customer_id', () => {
    for (const user of users) {
      expect(user.username).toMatch(/\.uji\./);
      expect(Object.keys(user).sort()).toEqual(
        user.role === 'customer'
          ? ['customer_id', 'id', 'role', 'username']
          : ['id', 'role', 'username'],
      );
    }
  });
});

describe('M1-01 loadSeedUsers rejects a seed file that breaks the rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privpay-seed-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const load = (content: unknown): (() => unknown) => {
    const file = join(dir, `seed-${String(Math.random()).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(content));
    return () => loadSeedUsers(file);
  };
  const customer = {
    id: 'usr-a',
    username: 'nasabah.uji.1',
    role: 'customer',
    customer_id: 'CUST-000101',
  };

  it('M1-01 accepts a valid file', () => {
    expect(load([customer])).not.toThrow();
  });

  it.each([
    ['an unknown role', [{ ...customer, role: 'superuser' }]],
    ['two roles', [{ ...customer, role: ['customer', 'admin'] }]],
    [
      'a customer without customer_id',
      [{ id: 'usr-a', username: 'nasabah.uji.1', role: 'customer' }],
    ],
    [
      'a customer_id on a non-customer',
      [{ id: 'usr-b', username: 'admin.uji.1', role: 'admin', customer_id: 'CUST-000101' }],
    ],
    ['an unknown field', [{ ...customer, email: 'someone@example.test' }]],
    ['a duplicate username', [customer, { ...customer, id: 'usr-b', customer_id: 'CUST-000102' }]],
    [
      'a duplicate customer_id',
      [customer, { ...customer, id: 'usr-b', username: 'nasabah.uji.2' }],
    ],
    ['not a list', { users: [] }],
  ])('M1-01 rejects %s', (_name, content) => {
    expect(load(content)).toThrow();
  });

  it('M1-01 the error does not repeat what the file held', () => {
    let message = '';
    try {
      load([{ ...customer, email: 'fake-value-do-not-print@example.test' }])();
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('fake-value-do-not-print');
  });
});
