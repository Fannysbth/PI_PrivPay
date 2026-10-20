import {
  classifyDatabase,
  runTestDatabasesCli,
  type PrivpayDatabase,
  type TestDatabaseStore,
} from '../src/testing';

// Seams: classifyDatabase (the guard that decides what may ever be dropped) and the command line with its store and
// prompt injected, so no database is needed. The real server is exercised in test-db-cleanup.integration.spec.ts.
const SERVICE_NAMES = [
  'privpay_privacy',
  'privpay_transaction',
  'privpay_fraud',
  'privpay_notification',
  'privpay_reconciliation',
];

describe('M0-05 classifyDatabase decides what may be dropped', () => {
  it.each(SERVICE_NAMES)('M0-05 %s is a service database', (name) => {
    expect(classifyDatabase(name)).toBe('service');
  });

  it.each([
    'privpay_privacy_test_m201',
    'privpay_transaction_test_m00415',
    'privpay_fraud_test_a',
    `privpay_notification_test_${'z'.repeat(20)}`,
  ])('M0-05 %s is a test database', (name) => {
    expect(classifyDatabase(name)).toBe('test');
  });

  it.each([
    'postgres',
    'template1',
    'my_app',
    'privpay_',
    'privpay_privacy_test_',
    'privpay_privacy_test_M201',
    'privpay_privacy_test_m2_01',
    'privpay_privacy_test_m201 ',
    'privpay_privacy_test_m201\n',
    "privpay_privacy_test_m201'; DROP DATABASE privpay_privacy; --",
    `privpay_privacy_test_${'z'.repeat(21)}`,
    'privpay_my_test_data',
    'privpay_privacy_test_m201_backup',
    'xprivpay_privacy_test_m201',
    'privpay_privacy2',
  ])('M0-05 %j is never droppable (not a test database of a service)', (name) => {
    expect(classifyDatabase(name)).toBe('other');
  });
});

function db(name: string, sessions = 0): PrivpayDatabase {
  return {
    name,
    kind: classifyDatabase(name),
    owner: 'privpay_x_owner',
    bytes: 8 * 1024 * 1024,
    sessions,
  };
}

function setup(databases: PrivpayDatabase[], answers: string[] = []) {
  const output: string[] = [];
  const dropped: string[][] = [];
  const prompts: string[] = [];
  const store: TestDatabaseStore = {
    list: () => Promise.resolve(databases),
    drop: (names) => {
      dropped.push([...names]);
      return Promise.resolve({ dropped: [...names], failed: [] });
    },
  };
  const ask = (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return Promise.resolve(answers.shift() ?? '');
  };
  return { store, ask, out: (line: string) => output.push(line), output, dropped, prompts };
}

const MIXED = [
  db('privpay_fraud'),
  db('privpay_fraud_test_m005b'),
  db('privpay_privacy', 2),
  db('privpay_privacy_test_m201'),
  db('privpay_privacy_test_m202', 1),
];

describe('M0-05 the cleanup command line lists first and drops nothing without the typed confirmation', () => {
  it('M0-05 list separates service databases from test leftovers and drops nothing', async () => {
    const t = setup(MIXED);
    expect(await runTestDatabasesCli([], t)).toBe(0);
    expect(await runTestDatabasesCli(['list'], t)).toBe(0);
    const text = t.output.join('\n');
    expect(text).toContain('privpay_fraud_test_m005b');
    expect(text).toMatch(/service databases/i);
    expect(text).toMatch(/test databases/i);
    expect(text.indexOf('privpay_privacy ')).toBeLessThan(text.indexOf('privpay_fraud_test_m005b'));
    expect(t.dropped).toEqual([]);
    expect(t.prompts).toEqual([]);
  });

  it('M0-05 drop shows the list of what would go and refuses an answer that is not the exact confirmation', async () => {
    for (const answer of ['', 'y', 'yes', 'DROP', 'DROP 2', 'drop 3', 'DROP 3 ']) {
      const t = setup(MIXED, [answer]);
      expect(await runTestDatabasesCli(['drop'], t)).toBe(1);
      expect(t.dropped).toEqual([]);
      expect(t.output.join('\n')).toContain('privpay_privacy_test_m201');
    }
  });

  it('M0-05 drop with the exact confirmation drops the test databases and only them', async () => {
    const t = setup(MIXED, ['DROP 3']);
    expect(await runTestDatabasesCli(['drop'], t)).toBe(0);
    expect(t.dropped).toEqual([
      ['privpay_fraud_test_m005b', 'privpay_privacy_test_m201', 'privpay_privacy_test_m202'],
    ]);
  });

  it('M0-05 drop never passes a name that is not a test database, even if the store lists one', async () => {
    const odd = { ...db('privpay_my_test_data'), kind: 'test' as const };
    const t = setup([db('privpay_privacy'), db('privpay_fraud_test_a'), odd], ['DROP 2']);
    expect(await runTestDatabasesCli(['drop'], t)).toBe(1);
    expect(t.dropped).toEqual([]);
  });

  it('M0-05 drop reports a database that could not be dropped and exits non-zero', async () => {
    const t = setup(MIXED, ['DROP 3']);
    t.store.drop = (names) =>
      Promise.resolve({
        dropped: names.slice(1),
        failed: [{ name: names[0] ?? '', code: '42501' }],
      });
    expect(await runTestDatabasesCli(['drop'], t)).toBe(1);
    expect(t.output.join('\n')).toMatch(/privpay_fraud_test_m005b.*42501/);
  });

  it('M0-05 drop with nothing to drop does not even ask', async () => {
    const t = setup([db('privpay_privacy')]);
    expect(await runTestDatabasesCli(['drop'], t)).toBe(0);
    expect(t.prompts).toEqual([]);
    expect(t.dropped).toEqual([]);
  });

  it.each([['--yes'], ['drop', '--yes'], ['drop', '-f'], ['purge'], ['list', 'drop']])(
    'M0-05 %j is a usage error: no way to skip the confirmation, nothing is touched',
    async (...args) => {
      const t = setup(MIXED, ['DROP 3']);
      expect(await runTestDatabasesCli(args, t)).toBe(2);
      expect(t.dropped).toEqual([]);
      expect(t.prompts).toEqual([]);
    },
  );
});
