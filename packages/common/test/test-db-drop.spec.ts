import type { Client } from 'pg';
import { FakeDelay } from '../src/delay';
import { dropWhenFree, TestDatabaseBusyError } from '../src/testing';

// Seam: dropWhenFree with a stub connection and a fake delay, so nothing sleeps. What it must do when the server
// refuses `DROP ... WITH (FORCE)` because a session of a role the test admin may not end is still on the database
// (a superuser such as pgAdmin): wait a short while, then fail with a message that says what to do. The real server is
// exercised by the integration tests of the harness.
const DATABASE = 'privpay_fraud_test_m005b';

function adminThatRejects(codes: (string | undefined)[]): { admin: Client; statements: string[] } {
  const statements: string[] = [];
  let call = 0;
  const admin = {
    escapeIdentifier: (name: string) => `"${name}"`,
    query: (sql: string) => {
      statements.push(sql);
      const code = codes[call];
      call += 1;
      return code === undefined
        ? Promise.resolve({ rows: [] })
        : Promise.reject(
            Object.assign(new Error('permission denied to terminate process'), { code }),
          );
    },
  } as unknown as Client;
  return { admin, statements };
}

describe('M0-05 dropWhenFree', () => {
  it('M0-05 drops the quoted database with FORCE when nothing holds it', async () => {
    const { admin, statements } = adminThatRejects([]);
    await dropWhenFree(admin, DATABASE, new FakeDelay());
    expect(statements).toEqual([`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`]);
  });

  it('M0-05 waits out a session that is still closing and then succeeds', async () => {
    const { admin } = adminThatRejects(['42501', '42501']);
    const delay = new FakeDelay();
    await dropWhenFree(admin, DATABASE, delay);
    expect(delay.waits).toEqual([100, 100]);
  });

  it('M0-05 a session it may not end becomes an error that names the database and says what to do', async () => {
    const { admin } = adminThatRejects(Array<string>(50).fill('42501'));
    const delay = new FakeDelay();
    const error: unknown = await dropWhenFree(admin, DATABASE, delay).catch((e: unknown) => e);
    if (!(error instanceof TestDatabaseBusyError))
      throw new Error('expected a TestDatabaseBusyError');
    expect(error.code).toBe('42501');
    expect(error.database).toBe(DATABASE);
    expect(error.message).toContain(DATABASE);
    expect(error.message).toMatch(/pgAdmin/);
    expect(error.message).toMatch(/disconnect/i);
    expect(delay.waits).toHaveLength(49);
  });

  it('M0-05 any other failure is passed on unchanged and at once', async () => {
    const { admin } = adminThatRejects(['55006']);
    const delay = new FakeDelay();
    const error: unknown = await dropWhenFree(admin, DATABASE, delay).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: '55006' });
    expect(error).not.toBeInstanceOf(TestDatabaseBusyError);
    expect(delay.waits).toEqual([]);
  });
});
