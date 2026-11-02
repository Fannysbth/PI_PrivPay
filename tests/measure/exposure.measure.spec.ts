import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, docker, edge, KONG_PORT, login, MODE, PROJECT } from '../docker/helpers';
import {
  buildCanary,
  CANARY_ATTRIBUTES,
  type Canary,
  type CanaryAttribute,
} from '../pii-scan/canary';
import {
  averages,
  compareWithExpected,
  exposureOf,
  PLACES,
  ZONE_SERVICES,
  type Observation,
  type Place,
} from '../pii-scan/exposure';
import { scanText } from '../pii-scan/scan';
import {
  claimsOf,
  commitInfo,
  containerLogs,
  containerOf,
  imageVersions,
  inPool,
  observerScan,
  pgDump,
  ROLE_TOKENS,
  tokenFor,
} from './support';
import { renderSummary } from './summary';

// M6-02: E(s) measured through Kong on the running Compose stack, with the observer overlay (deploy/measure). One customer
// is registered, signed in and pays; the scans then read the payload each downstream service received, its database and its
// log. The expectation of Tabel IV is data in tests/pii-scan/exposure.ts and is not read by any step of the flow: a difference
// is reported, nothing is tuned. Every value is a fictional canary built here; the output holds attribute names and counts only.
const CUSTOMERS = Number(process.env['MEASURE_CUSTOMERS'] ?? '1000');
const OUT = join(__dirname, '..', '..', 'docs', 'hasil');
const base = Math.floor(Date.now() / 1000) % 90_000;
// Only a pilot on a stack that already holds today's batch sets MEASURE_BATCH_DATE; the real run uses a fresh stack and today.
const today = process.env['MEASURE_BATCH_DATE'] ?? new Date().toISOString().slice(0, 10);

interface Customer {
  readonly canary: Canary;
  readonly username: string;
  customerId: string;
  transactionIds: string[];
  statuses: string[];
}

const customers: Customer[] = Array.from({ length: CUSTOMERS }, (_, index) => {
  const canary = buildCanary(base + index);
  return {
    canary,
    username: `uji.ukur.${String(base + index).padStart(5, '0')}`,
    customerId: '',
    transactionIds: [],
    statuses: [],
  };
});
/** The customer_id is made by the IdP at registration, so it is learned from the customer's own token, then matched exactly. */
const learned = (): Canary[] => customers.map((c) => ({ ...c.canary, customer_id: c.customerId }));

const observations: Observation[] = [];
const note = (service: string, place: Place, text: string, list: readonly Canary[]): void => {
  for (const finding of scanText(text, list, { service, location: place })) {
    observations.push({ service, attribute: finding.attribute, place });
  }
};
const report: Record<string, unknown> = {};

const planted = buildCanary(99_999);
const plantedValues = CANARY_ATTRIBUTES.map((attribute) => planted[attribute]);
const attributesIn = (text: string): CanaryAttribute[] =>
  scanText(text, [planted], { service: 'control', location: 'control' }).map((f) => f.attribute);

describe(`M6-02 exposure E(s) through Kong (${MODE}, ${String(CUSTOMERS)} customers)`, () => {
  it('M6-02 control: a canary planted in a payload, in a database and in a log is found by each scanner', async () => {
    // Payload: through the observer's Transaction listener, which forwards and keeps the exchange in memory.
    await fetch('http://127.0.0.1:4102/planted', {
      method: 'POST',
      body: JSON.stringify({ values: plantedValues }),
    });
    const payload = (await observerScan([planted])).findings
      .filter((f) => f.service === 'transaction')
      .map((f) => f.attribute);
    // Database: a throwaway database with the canary in a table, dumped the way the real ones are.
    const pg = containerOf('pg-fraud');
    docker(['exec', pg, 'psql', '-U', 'postgres', '-c', 'CREATE DATABASE privpay_measure_control']);
    let database: CanaryAttribute[];
    try {
      const rows = plantedValues.map((v) => `('${v}')`).join(',');
      docker([
        'exec',
        pg,
        'psql',
        '-U',
        'postgres',
        '-d',
        'privpay_measure_control',
        '-c',
        `CREATE TABLE planted(v text); INSERT INTO planted VALUES ${rows}`,
      ]);
      database = attributesIn(
        docker([
          'exec',
          pg,
          'pg_dump',
          '-U',
          'postgres',
          '-d',
          'privpay_measure_control',
          '--data-only',
        ]),
      );
    } finally {
      docker([
        'exec',
        pg,
        'psql',
        '-U',
        'postgres',
        '-c',
        'DROP DATABASE IF EXISTS privpay_measure_control',
      ]);
    }
    // Log: a throwaway container that prints the canary, read with the same call as the real logs.
    const name = 'privpay-measure-logctl';
    docker([
      'run',
      '--name',
      name,
      '--entrypoint',
      'node',
      'privpay-gateway:dk01a',
      '-e',
      'console.log(process.argv.slice(1).join(" "))',
      ...plantedValues,
    ]);
    let log: CanaryAttribute[];
    try {
      log = attributesIn(containerLogs(name));
    } finally {
      docker(['rm', name]);
    }
    report['controls'] = { payload, database, log, expectedEach: [...CANARY_ATTRIBUTES] };
    for (const found of [payload, database, log])
      expect([...found].sort()).toEqual([...CANARY_ATTRIBUTES].sort());
  });

  it('M6-02 flow: register, sign in, pay (normal, history, suspicious), review, settle, reconcile, notify', async () => {
    const started = Date.now();
    let registered = 0;
    await inPool(customers, 6, async (customer, index) => {
      const c = customer.canary;
      const answer = await call(
        { port: KONG_PORT, path: '/register', tls: true },
        {
          nik: c.nik,
          nama: c.nama,
          hp: c.hp,
          email: c.email,
          rekening: c.rekening,
          username: customer.username,
        },
      );
      if (answer.status !== 201)
        throw new Error(`registration ${String(index)} answered ${String(answer.status)}`);
      registered += 1;
      const token = await login(customer.username);
      const id = claimsOf(token)['customer_id'];
      if (typeof id !== 'string') throw new Error('the token has no customer_id');
      customer.customerId = id;
      // The same client behaviour in both modes: the payment form carries nik and nama (Tabel IV premise, N-48).
      const pay = async (amount: number, geohash: string): Promise<void> => {
        const paid = await edge(
          '/transaction',
          { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
          {
            source_account: c.rekening,
            merchant_id: 'MRC-001',
            amount,
            geohash,
            nik: c.nik,
            nama: c.nama,
          },
        );
        const body = paid.body as { transaction_id?: string; status?: string };
        if (paid.status !== 201 || typeof body.transaction_id !== 'string') {
          throw new Error(`payment answered ${String(paid.status)}`);
        }
        customer.transactionIds.push(body.transaction_id);
        customer.statuses.push(String(body.status));
      };
      await pay(35_000, 'qqgu4');
      await pay(36_000, 'qqgu4');
      // Fraud only assesses payments at or above its threshold (1.000.000), so a quarter of the customers build a history with
      // a large payment and then pay from a new place: that reaches Fraud twice and is held for the analyst.
      if (index % 4 === 0) {
        await pay(2_000_000, 'qqgu7');
        await pay(8_000_000, 'qqt8h');
      }
    });

    // The analyst approves what was held (the review path), the bank reports, the admin reconciles.
    let reviewed = 0;
    for (let round = 0; round < 40; round += 1) {
      const analyst = await tokenFor(ROLE_TOKENS.analyst);
      const held = await call({
        port: KONG_PORT,
        path: '/transaction/held?limit=50',
        method: 'GET',
        headers: { authorization: `Bearer ${analyst}` },
        tls: true,
      });
      const items = (held.body as { items?: { transaction_id: string }[] }).items ?? [];
      if (items.length === 0) break;
      await inPool(items, 4, async (item) => {
        const done = await edge(
          `/transaction/${item.transaction_id}/review`,
          { authorization: `Bearer ${analyst}` },
          { decision: 'APPROVE', reason_code: 'CONFIRMED_BY_CUSTOMER' },
        );
        if (done.status !== 200) throw new Error(`review answered ${String(done.status)}`);
        reviewed += 1;
      });
    }
    const bank = await tokenFor(ROLE_TOKENS.bank);
    const reported = customers.slice(0, Math.min(500, CUSTOMERS));
    const settlement = await edge(
      '/settlement/report',
      { authorization: `Bearer ${bank}` },
      {
        batch_date: today,
        items: reported.map((c, i) => ({
          account_number: c.canary.rekening,
          amount: 35_000,
          bank_reference: `REF-${String(base)}-${String(i)}`,
        })),
      },
    );
    const admin = await tokenFor(ROLE_TOKENS.admin);
    const run = await edge(
      '/reconciliation/run',
      { authorization: `Bearer ${admin}` },
      { date: today },
    );
    // The Gateway gives a downstream call 3 s (NFR-12). If the run is slower, the client sees 503 although the service finished:
    // the service's own log line (same request_id) says what it answered. Reported as a finding, not tuned.
    const runRequestId = (run.body as { error?: { request_id?: string }; request_id?: string })
      .error?.request_id;
    // The scans below must not start before the run has finished, so wait (up to two minutes) for the service's own line.
    let serviceSide: { status: number; latency_ms: number } | null = null;
    for (let wait = 0; run.status !== 200 && serviceSide === null && wait < 60; wait += 1) {
      const line = containerLogs(containerOf('reconciliation-service'))
        .split(String.fromCharCode(10))
        .find(
          (entry) =>
            runRequestId !== undefined &&
            entry.includes(runRequestId) &&
            entry.includes('/reconciliation/run'),
        );
      if (line !== undefined)
        serviceSide = JSON.parse(line) as { status: number; latency_ms: number };
      else await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const statuses = customers.flatMap((c) => c.statuses);
    report['flow'] = {
      customers: CUSTOMERS,
      registered,
      payments: statuses.length,
      completedOrHeldAtPayment: {
        COMPLETED: statuses.filter((s) => s === 'COMPLETED').length,
        HELD: statuses.filter((s) => s === 'HELD').length,
      },
      reviewed,
      settlementReportStatus: settlement.status,
      settlementItems: reported.length,
      reconciliationRunStatus: run.status,
      reconciliationRunServiceSide: serviceSide,
      reconciliation: run.body,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    expect(registered).toBe(CUSTOMERS);
    expect(settlement.status).toBe(202);
  });

  it('M6-02 scan: payload, database and log of every service, then the comparison with Tabel IV', async () => {
    const list = learned();
    const payload = await observerScan(list);
    for (const finding of payload.findings)
      observations.push({
        service: finding.service,
        attribute: finding.attribute,
        place: 'payload',
      });
    for (const service of ZONE_SERVICES) {
      note(service, 'database', pgDump(service), list);
      note(service, 'log', containerLogs(containerOf(`${service}-service`)), list);
    }
    // Components outside Tabel IV, reported as information: the edge, the Gateway, the SMS provider, the vault.
    const others: Record<string, Record<Place, CanaryAttribute[]>> = {};
    const other = (name: string, place: Place, text: string): void => {
      const found = scanText(text, list, { service: name, location: place }).map(
        (f) => f.attribute,
      );
      (others[name] ??= { payload: [], database: [], log: [] })[place] = found;
    };
    for (const name of ['kong', 'gateway', 'sms-simulator'])
      other(name, 'log', containerLogs(containerOf(name)));
    if (MODE === 'proposed') {
      other('privacy-service', 'log', containerLogs(containerOf('privacy-service')));
      other('privacy-service', 'database', pgDump('privacy'));
    }
    // Auth (Keycloak) is outside the protected zone (DF19): what its own API says it holds, and its log.
    const idpAdmin = await tokenFor({ client: 'idp-admin', secretFile: 'idp-admin_client_secret' });
    const users = await fetch(
      `http://127.0.0.1:${process.env['IDP_HOST_PORT'] ?? '8080'}/admin/realms/privpay/users?max=5000`,
      { headers: { authorization: `Bearer ${idpAdmin}` } },
    );
    const authObservations: Observation[] = [];
    const usersText = await users.text();
    for (const f of scanText(usersText, list, { service: 'auth', location: 'database' }))
      authObservations.push({ service: 'auth', attribute: f.attribute, place: 'database' });
    for (const f of scanText(containerLogs(containerOf('keycloak')), list, {
      service: 'auth',
      location: 'log',
    }))
      authObservations.push({ service: 'auth', attribute: f.attribute, place: 'log' });

    const rows = compareWithExpected(MODE, observations);
    const detail = ZONE_SERVICES.map((service) => exposureOf(observations, service));
    const auth = exposureOf(authObservations, 'auth');
    const mean = averages(
      detail.map((d) => ({ service: d.service, e: d.e })),
      { service: 'auth', e: auth.e },
    );
    report['exposure'] = {
      exchangesObservedByProxy: payload.exchanges,
      usersApiStatus: users.status,
      rows,
      detail,
      auth,
      averages: mean,
      averagesClassGeneral: averages(
        detail.map((d) => ({ service: d.service, e: d.eUmum })),
        { service: 'auth', e: auth.eUmum },
      ),
      averagesClassSpecific: averages(
        detail.map((d) => ({ service: d.service, e: d.eSpesifik })),
        { service: 'auth', e: auth.eSpesifik },
      ),
      others,
    };
    expect(users.status).toBe(200);
    expect(PLACES).toHaveLength(3);
  });

  it('M6-02 disclosure (reported apart): approved attributes only, audited without values, nothing kept afterwards', async () => {
    const sample = customers.slice(0, Math.min(5, CUSTOMERS));
    const auditor = await tokenFor(ROLE_TOKENS.auditor);
    const admin = await tokenFor(ROLE_TOKENS.admin);
    const result = {
      attempted: sample.length,
      auditTokensIssued: 0,
      statusOfAuditRequest: [] as number[],
      opened: 0,
      onlyApprovedAttribute: 0,
      valueMatchesRegistered: 0,
      auditRowsFound: 0,
      auditTextClean: 0,
      routineAuditTextClean: 0,
    };
    const list = learned();
    for (const [index, customer] of sample.entries()) {
      const transactionId = customer.transactionIds[0];
      if (transactionId === undefined) continue;
      const asked = await edge(
        '/reconciliation/audit-request',
        { authorization: `Bearer ${auditor}` },
        { transaction_id: transactionId, reason_code: 'DISPUTE' },
      );
      result.statusOfAuditRequest.push(asked.status);
      if (asked.status !== 200) continue;
      const auditToken = (asked.body as { audit_token?: string }).audit_token;
      if (typeof auditToken !== 'string') continue;
      result.auditTokensIssued += 1;
      if (scanText(JSON.stringify(asked.body), list, { service: 'x', location: 'x' }).length === 0)
        result.routineAuditTextClean += 1;
      const requested = await edge(
        '/disclosure-requests',
        { authorization: `Bearer ${auditor}` },
        {
          audit_token: auditToken,
          basis: 'DISPUTE',
          case_ref: `KASUS-UKUR-${String(base)}-${String(index)}`,
          attributes: ['nama'],
        },
      );
      const disclosureId = (requested.body as { disclosure_id?: string }).disclosure_id;
      if (typeof disclosureId !== 'string') continue;
      await edge(
        `/disclosure-requests/${disclosureId}/approve`,
        { authorization: `Bearer ${admin}` },
        {},
      );
      const opened = await edge(
        '/reconciliation/disclosure',
        { authorization: `Bearer ${auditor}` },
        { audit_token: auditToken, disclosure_id: disclosureId },
      );
      const attributes = (opened.body as { attributes?: Record<string, string> }).attributes;
      if (opened.status === 200 && attributes !== undefined) {
        result.opened += 1;
        if (Object.keys(attributes).join() === 'nama') result.onlyApprovedAttribute += 1;
        if (attributes['nama'] === customer.canary.nama) result.valueMatchesRegistered += 1;
      }
      const trail = await call({
        port: KONG_PORT,
        path: `/audit-log?action=DE_PSEUDONYMIZE&disclosure_id=${disclosureId}`,
        method: 'GET',
        headers: { authorization: `Bearer ${auditor}` },
        tls: true,
      });
      const rowsOfTrail = (trail.body as { items?: unknown[] }).items ?? [];
      if (rowsOfTrail.length > 0) result.auditRowsFound += 1;
      if (scanText(JSON.stringify(trail.body), list, { service: 'x', location: 'x' }).length === 0)
        result.auditTextClean += 1;
    }
    // What the disclosure left behind: the databases and logs of Reconciliation (and the vault's log) read again for the five names.
    const opened = sample.map((c) => c.canary);
    const residue: Record<string, CanaryAttribute[]> = {};
    const check = (name: string, text: string): void => {
      residue[name] = scanText(text, opened, { service: name, location: 'residue' }).map(
        (f) => f.attribute,
      );
    };
    check('reconciliation database', pgDump('reconciliation'));
    check('reconciliation log', containerLogs(containerOf('reconciliation-service')));
    check('gateway log', containerLogs(containerOf('gateway')));
    check('kong log', containerLogs(containerOf('kong')));
    report['disclosure'] = {
      available: result.opened > 0,
      ...result,
      residueAfterDisclosure: residue,
    };
    if (MODE === 'proposed') expect(result.attempted).toBeGreaterThan(0);
  });

  afterAll(() => {
    const info = commitInfo();
    const history =
      docker([
        'inspect',
        '-f',
        '{{range .Config.Env}}{{println .}}{{end}}',
        containerOf('fraud-service'),
      ])
        .split('\n')
        .find((line) => line.startsWith('FRAUD_HISTORY_DAYS=')) ?? 'FRAUD_HISTORY_DAYS=?';
    const meta = {
      mode: MODE,
      project: PROJECT,
      date: new Date().toISOString(),
      commit: info.commit,
      workingTreeDirty: info.dirty,
      fraudHistoryDays: history.split('=')[1],
      customers: CUSTOMERS,
      gatewayInFront: 'Kong 3.9.4 -> gateway-adapter (Keycloak as IdP)',
      rateLimit: 'off for the measurement (adapter and Kong), the same in both modes',
      clientSendsNikNamaWithPayment:
        'yes in both modes (identical client behaviour; baseline forwards, proposed drops at the Gateway)',
      images: imageVersions(),
      scope:
        'structural exposure of direct identifiers; not re-identification risk; not a performance measurement',
    };
    mkdirSync(OUT, { recursive: true });
    const full = { meta, ...report };
    writeFileSync(join(OUT, `e-s-${MODE}.json`), `${JSON.stringify(full, null, 2)}\n`);
    writeFileSync(join(OUT, `e-s-${MODE}.md`), renderSummary(full));
  });
});
