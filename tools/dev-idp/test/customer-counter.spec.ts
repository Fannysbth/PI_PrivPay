import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@privpay/common';
import { fileCustomerCounter } from '../src/customer-counter';
import { IdentityProvider, type CustomerCounter } from '../src/identity-provider';
import { DEFAULT_REGISTRY } from '../src/registry';
import { loadSeedUsers, SEED_FILE } from '../src/seed';

// Fake secrets, made up for the test run.
const SECRETS = {
  'api-gateway': 'fake-secret-api-gateway',
  transaction: 'fake-secret-transaction',
  fraud: 'fake-secret-fraud',
  notification: 'fake-secret-notification',
  reconciliation: 'fake-secret-reconciliation',
};

const make = (customerCounter: CustomerCounter): IdentityProvider =>
  new IdentityProvider({
    clock: new FakeClock(new Date('2026-10-24T08:00:00Z')),
    ttlSeconds: 300,
    serviceSecrets: SECRETS,
    users: loadSeedUsers(SEED_FILE),
    registry: DEFAULT_REGISTRY,
    customerCounter,
  });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'privpay-dev-idp-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('N-51 finding 1: a customer_id is never handed out twice across restarts', () => {
  it('N-51 two starts in a row never produce the same customer_id', () => {
    const file = join(dir, 'customer-counter');
    const first = make(fileCustomerCounter(file));
    const before = [
      first.createCustomer('nasabah.uji.501').customer_id,
      first.createCustomer('nasabah.uji.502').customer_id,
    ];
    // A restart: a new provider over the same state, as dev:up does after dev:down.
    const second = make(fileCustomerCounter(file));
    const after = [
      second.createCustomer('nasabah.uji.501').customer_id,
      second.createCustomer('nasabah.uji.502').customer_id,
    ];
    expect(before).toEqual(['CUST-000104', 'CUST-000105']);
    expect(after).toEqual(['CUST-000106', 'CUST-000107']);
  });

  it('N-51 a deleted customer_id is not handed out again after a restart either', () => {
    const file = join(dir, 'customer-counter');
    const first = make(fileCustomerCounter(file));
    const created = first.createCustomer('nasabah.uji.510');
    first.deleteCustomer(created.customer_id);
    const second = make(fileCustomerCounter(file));
    expect(second.createCustomer('nasabah.uji.510').customer_id).toBe('CUST-000105');
  });

  it('N-51 the seed users do not change: same ids, and a counter below the seed does not lower the start', () => {
    const file = join(dir, 'customer-counter');
    writeFileSync(file, '000003');
    const idp = make(fileCustomerCounter(file));
    expect(idp.createCustomer('nasabah.uji.520').customer_id).toBe('CUST-000104');
    const seed = loadSeedUsers(SEED_FILE)
      .filter((user) => user.customer_id !== undefined)
      .map((user) => user.customer_id);
    expect(seed).toEqual(['CUST-000101', 'CUST-000102', 'CUST-000103']);
  });

  it('N-51 a counter file that cannot be read stops the start instead of starting from zero', () => {
    const file = join(dir, 'customer-counter');
    writeFileSync(file, 'not a number');
    expect(() => make(fileCustomerCounter(file))).toThrow();
  });

  it('N-51 the number is stored before the user exists: a failed write registers nobody', () => {
    let failing = true;
    const idp = make({
      read: () => 0,
      write: () => {
        if (failing) throw new Error('disk full');
      },
    });
    expect(() => idp.createCustomer('nasabah.uji.530')).toThrow('disk full');
    // The username is still free and the number was not used up by the failure.
    failing = false;
    expect(idp.createCustomer('nasabah.uji.530').customer_id).toBe('CUST-000104');
  });
});
