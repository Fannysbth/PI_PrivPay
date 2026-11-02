import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docker, edge, KONG_PORT, login, MODE, PROJECT } from '../docker/helpers';
import { buildCanary } from '../pii-scan/canary';
import { crossServiceLinking, withinServiceGrouping, type LinkRow } from './linkage';
import { claimsOf, commitInfo, containerOf, inPool, ROLE_TOKENS, tokenFor } from './support';

// M6-03: the linkage attack of Metodologi D.3 as the design allows it: an attacker holding READ copies of the downstream
// databases (a leak), who joins rows by equal identifier values. The evaluator knows whose each row is (unique amounts, phones
// and bank references planted by this run) and scores the attacker against that; the attacker's join never reads it. The
// attack is NOT a break-in, and it is not a proof of unlinkability: it counts what this one join could and could not link.
const SUBJECTS = Number(process.env['MEASURE_LINK_SUBJECTS'] ?? '200');
const OUT = join(__dirname, '..', '..', 'docs', 'hasil');
const FIRST = 95_000;
const tag = String(Math.floor(Date.now() / 1000) % 100_000);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const amountOf = (i: number, k: number): number => 1_100_000 + i * 1000 + k;

// Per service: the column that tells the evaluator whose the row is, and the columns the attacker may join on.
const SHAPE = {
  proposed: {
    transaction: {
      sql: 'SELECT amount, customer_pseudonym, account_pseudonym FROM transactions',
      truth: 'amount',
      refs: ['customer_pseudonym', 'account_pseudonym'],
    },
    fraud: {
      sql: 'SELECT amount, pseudonym FROM fraud_assessments',
      truth: 'amount',
      refs: ['pseudonym'],
    },
    notification: {
      sql: 'SELECT phone, pseudonym FROM contact_registry',
      truth: 'phone',
      refs: ['pseudonym'],
    },
    reconciliation: {
      sql: 'SELECT bank_reference, account_pseudonym FROM settlement_items',
      truth: 'bank_reference',
      refs: ['account_pseudonym'],
    },
  },
  baseline: {
    transaction: {
      sql: 'SELECT amount, customer_id, account_number, nik, nama FROM transactions',
      truth: 'amount',
      refs: ['customer_id', 'account_number', 'nik', 'nama'],
    },
    fraud: {
      sql: 'SELECT amount, customer_id, account_number, nik, nama FROM fraud_assessments',
      truth: 'amount',
      refs: ['customer_id', 'account_number', 'nik', 'nama'],
    },
    notification: {
      sql: 'SELECT phone, customer_id, account_number, nik, nama FROM contact_registry',
      truth: 'phone',
      refs: ['customer_id', 'account_number', 'nik', 'nama'],
    },
    reconciliation: {
      sql: 'SELECT bank_reference, account_number, customer_id, nik, nama FROM settlement_items',
      truth: 'bank_reference',
      refs: ['account_number', 'customer_id', 'nik', 'nama'],
    },
  },
} as const;
const SERVICES = ['transaction', 'fraud', 'notification', 'reconciliation'] as const;

interface Subject {
  readonly index: number;
  readonly username: string;
  readonly canary: ReturnType<typeof buildCanary>;
  customerId: string;
}
const subjects: Subject[] = Array.from({ length: SUBJECTS }, (_, index) => ({
  index,
  username: `uji.taut.${tag}${String(index).padStart(3, '0')}`,
  canary: buildCanary(FIRST + index),
  customerId: '',
}));

/** What the attacker's copy of one database gives: every row with its subject-reference columns, scored by the evaluator's truth. */
function rowsOf(service: (typeof SERVICES)[number]): LinkRow[] {
  const shape = SHAPE[MODE][service];
  const truthOf = new Map<string, string>();
  for (const s of subjects) {
    if (service === 'notification') truthOf.set(s.canary.hp, String(s.index));
    else if (service === 'reconciliation')
      truthOf.set(`REFL-${tag}-${String(s.index)}`, String(s.index));
    else {
      truthOf.set(String(amountOf(s.index, 0)), String(s.index));
      truthOf.set(String(amountOf(s.index, 1)), String(s.index));
    }
  }
  const out = docker([
    'exec',
    containerOf(`pg-${service}`),
    'psql',
    '-U',
    'postgres',
    '-d',
    `privpay_${service}`,
    '-At',
    '-F',
    '|',
    '-c',
    shape.sql,
  ]);
  const names = shape.sql
    .replace(/^SELECT /, '')
    .replace(/ FROM .*/, '')
    .split(', ');
  return out
    .split(String.fromCharCode(10))
    .filter((line) => line !== '')
    .map((line) => {
      const cells = line.split('|');
      const byName = Object.fromEntries(names.map((name, i) => [name, cells[i] ?? '']));
      // amounts come out as numeric text such as 1100000.00
      const key = (byName[shape.truth] ?? '').replace(/\.0+$/, '');
      return {
        service,
        subject: truthOf.get(key) ?? null,
        refs: Object.fromEntries(shape.refs.map((name) => [name, byName[name] ?? ''])),
      };
    });
}

const report: Record<string, unknown> = {};

describe(`M6-03 linkage attack on copies of the databases (${MODE}, ${String(SUBJECTS)} subjects)`, () => {
  it('M6-03 setup: subjects register, pay twice at or above the Fraud threshold, and the bank reports them', async () => {
    await inPool(subjects, 6, async (subject) => {
      const c = subject.canary;
      const answer = await edge(
        '/register',
        {},
        {
          nik: c.nik,
          nama: c.nama,
          hp: c.hp,
          email: c.email,
          rekening: c.rekening,
          username: subject.username,
        },
      );
      if (answer.status !== 201) throw new Error(`registration answered ${String(answer.status)}`);
      const token = await login(subject.username);
      const id = claimsOf(token)['customer_id'];
      if (typeof id !== 'string') throw new Error('the token has no customer_id');
      subject.customerId = id;
      for (const k of [0, 1]) {
        const paid = await edge(
          '/transaction',
          { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
          {
            source_account: c.rekening,
            merchant_id: 'MRC-001',
            amount: amountOf(subject.index, k),
            geohash: 'qqgu4',
            nik: c.nik,
            nama: c.nama,
          },
        );
        if (paid.status !== 201) throw new Error(`payment answered ${String(paid.status)}`);
      }
    });
    const bank = await tokenFor(ROLE_TOKENS.bank);
    const settled = await edge(
      '/settlement/report',
      { authorization: `Bearer ${bank}` },
      {
        batch_date: yesterday,
        items: subjects.map((s) => ({
          account_number: s.canary.rekening,
          amount: amountOf(s.index, 0),
          bank_reference: `REFL-${tag}-${String(s.index)}`,
        })),
      },
    );
    expect(settled.status).toBe(202);
  });

  it('M6-03 attack: join the copies by equal identifier values, pair by pair and with all services colluding', () => {
    const rows = SERVICES.flatMap((service) => rowsOf(service));
    const linking = crossServiceLinking(rows, SERVICES);
    const within = SERVICES.map((service) => withinServiceGrouping(rows, service));
    report['attack'] = {
      method:
        'equal-value join of the subject-reference columns of the copied databases; ground truth only scores it',
      rowsPerService: Object.fromEntries(
        SERVICES.map((s) => [s, rows.filter((r) => r.service === s).length]),
      ),
      rowsWithKnownSubject: Object.fromEntries(
        SERVICES.map((s) => [s, rows.filter((r) => r.service === s && r.subject !== null).length]),
      ),
      columnsJoined: Object.fromEntries(SERVICES.map((s) => [s, SHAPE[MODE][s].refs])),
      ...linking,
      withinService: within,
    };
    // Positive control (Metodologi): in baseline the same method MUST link; if it does not, the method is broken, not the system safe.
    const pair = linking.pairs.find((p) => p.a === 'transaction' && p.b === 'fraud');
    report['control'] = {
      baselineMustLink: MODE === 'baseline',
      transactionFraudRate: pair?.rate ?? null,
      withinServiceMethodWorks: within.some((w) => (w.recall ?? 0) > 0),
    };
    if (MODE === 'baseline') expect(pair?.rate ?? 0).toBeGreaterThan(0.9);
    // The method also has to be able to link inside a service (same pseudonym, same subject), proposed or not.
    expect(within.some((w) => (w.recall ?? 0) > 0)).toBe(true);
  });

  it('M6-03 known limitation N-51: a subject that was revoked can pay again and receives a token (reported, not judged)', async () => {
    const admin = await tokenFor(ROLE_TOKENS.admin);
    const sample = subjects.slice(0, Math.min(3, SUBJECTS));
    const results: Record<string, unknown>[] = [];
    for (const subject of sample) {
      const revoked = await edge(
        '/subject/revoke',
        { authorization: `Bearer ${admin}` },
        { subject_type: 'CUSTOMER', subject_id: subject.customerId },
      );
      const token = await login(subject.username);
      const again = await edge(
        '/transaction',
        { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        {
          source_account: subject.canary.rekening,
          merchant_id: 'MRC-001',
          amount: amountOf(subject.index, 2),
          geohash: 'qqgu4',
        },
      );
      const before = docker([
        'exec',
        containerOf('pg-transaction'),
        'psql',
        '-U',
        'postgres',
        '-d',
        'privpay_transaction',
        '-At',
        '-c',
        `SELECT count(DISTINCT ${MODE === 'proposed' ? 'customer_pseudonym' : 'customer_id'}) FROM transactions WHERE amount IN (${String(amountOf(subject.index, 0))}, ${String(amountOf(subject.index, 1))}, ${String(amountOf(subject.index, 2))})`,
      ]).trim();
      results.push({
        revokeStatus: revoked.status,
        payAfterRevokeStatus: again.status,
        distinctCustomerReferencesAcrossBeforeAndAfter: Number(before),
      });
    }
    report['revokeThenPay'] = {
      note: 'N-51: the revoked subject is not cut off; a new token is issued. 1 distinct reference means the same reference is reused (baseline); 2 means a new token',
      results,
    };
  });

  afterAll(() => {
    const info = commitInfo();
    mkdirSync(OUT, { recursive: true });
    const full = {
      meta: {
        mode: MODE,
        project: PROJECT,
        date: new Date().toISOString(),
        commit: info.commit,
        workingTreeDirty: info.dirty,
        subjects: SUBJECTS,
        kongPort: KONG_PORT,
        scope:
          'empirical on the data of this run; not a formal proof of unlinkability; the attacker has read copies of downstream databases, not the keys or the Privacy Service',
        notMeasured:
          'linkage through quasi-identifiers (amount, hour, geohash); token expiry after the 30-day window (needs real time)',
      },
      ...report,
    };
    writeFileSync(join(OUT, `tautan-${MODE}.json`), `${JSON.stringify(full, null, 2)}\n`);
  });
});
