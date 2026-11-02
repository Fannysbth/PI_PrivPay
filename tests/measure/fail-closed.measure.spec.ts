import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, docker, edge, KONG_PORT, login, MODE, PROJECT } from '../docker/helpers';
import { buildCanary, type Canary } from '../pii-scan/canary';
import { scanText } from '../pii-scan/scan';
import {
  commitInfo,
  containerLogs,
  containerOf,
  observerScan,
  pgDump,
  ROLE_TOKENS,
  tokenFor,
} from './support';

// M6-04: fail-closed on the Compose stack (proposed only: baseline has no Privacy Service). With the Privacy container
// stopped, then paused (alive but not answering), every route that needs it must answer 503 in the one shape of ADR-0008, and
// the real values sent in that moment must reach no downstream service, database, log or response. Then it is started again and
// a payment must pass. Recovery times are what this laptop did; they are not a performance claim (ADR-0004).
const OUT = join(__dirname, '..', '..', 'docs', 'hasil');
const PRIVACY = containerOf('privacy-service');
const base = 97_000 + (Math.floor(Date.now() / 1000) % 900);
const outage: Record<string, Canary> = {
  payment: buildCanary(base),
  registration: buildCanary(base + 1),
  settlement: buildCanary(base + 2),
  phone: buildCanary(base + 3),
};
const everyCanary = Object.values(outage);
const known = buildCanary(base + 4); // a customer registered while Privacy is up, so the outage requests have a token to carry
const username = `uji.tutup.${String(base + 4)}`;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Attempt {
  route: string;
  condition: string;
  status: number;
  shapeOk: boolean;
  codeOk: boolean;
  responseCarriesValue: boolean;
}
const attempts: Attempt[] = [];
const report: Record<string, unknown> = {};

const shapeOf = (body: unknown): { shapeOk: boolean; codeOk: boolean } => {
  const error = (body as { error?: Record<string, unknown> }).error;
  return {
    shapeOk: error !== undefined && Object.keys(error).sort().join() === 'code,message,request_id',
    codeOk: error?.['code'] === 'SERVICE_UNAVAILABLE',
  };
};

async function secondsUntilHealthy(): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < 90; i += 1) {
    if (docker(['inspect', '--format', '{{.State.Health.Status}}', PRIVACY]).trim() === 'healthy') {
      return (Date.now() - started) / 1000;
    }
    await wait(1000);
  }
  throw new Error('the Privacy Service did not become healthy again');
}

if (MODE === 'proposed') {
  describe('M6-04 Privacy Service switched off and unresponsive: the stack fails closed (proposed)', () => {
    let token = '';
    let transactionId = '';

    it('M6-04 setup and control: the payload scanner sees a planted canary in this run', async () => {
      const registered = await edge(
        '/register',
        {},
        {
          nik: known.nik,
          nama: known.nama,
          hp: known.hp,
          email: known.email,
          rekening: known.rekening,
          username,
        },
      );
      expect(registered.status).toBe(201);
      token = await login(username);
      const paid = await edge(
        '/transaction',
        { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        {
          source_account: known.rekening,
          merchant_id: 'MRC-001',
          amount: 35_000,
          geohash: 'qqgu4',
        },
      );
      expect(paid.status).toBe(201);
      transactionId = (paid.body as { transaction_id: string }).transaction_id;
      // Control: the observer must report an outage canary if one reached Transaction.
      await fetch('http://127.0.0.1:4102/planted', {
        method: 'POST',
        body: JSON.stringify({ v: outage['payment']?.rekening }),
      });
      const control = (await observerScan(everyCanary)).findings
        .filter((f) => f.service === 'transaction')
        .map((f) => f.attribute);
      report['control'] = { plantedCanaryFoundByPayloadScanner: control };
      expect(control).toContain('rekening');
    });

    const routes = async (condition: string): Promise<void> => {
      const auditor = await tokenFor(ROLE_TOKENS.auditor);
      const bank = await tokenFor(ROLE_TOKENS.bank);
      const record = (route: string, answer: { status: number; body: unknown }): void => {
        const shape = shapeOf(answer.body);
        const carries =
          scanText(JSON.stringify(answer.body), everyCanary, {
            service: 'response',
            location: 'response',
          }).length > 0;
        attempts.push({
          route,
          condition,
          status: answer.status,
          ...shape,
          responseCarriesValue: carries,
        });
      };
      const payment = outage['payment'] as Canary;
      const registration = outage['registration'] as Canary;
      const settlement = outage['settlement'] as Canary;
      const phone = outage['phone'] as Canary;
      record(
        'POST /transaction',
        await edge(
          '/transaction',
          { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
          {
            source_account: payment.rekening,
            merchant_id: 'MRC-001',
            amount: 35_000,
            geohash: 'qqgu4',
            nik: payment.nik,
            nama: payment.nama,
          },
        ),
      );
      record(
        'POST /notification/register',
        await edge(
          '/notification/register',
          { authorization: `Bearer ${token}` },
          { phone: phone.hp, channel: 'SMS' },
        ),
      );
      record(
        'POST /settlement/report',
        await edge(
          '/settlement/report',
          { authorization: `Bearer ${bank}` },
          {
            batch_date: '2026-01-02',
            items: [
              {
                account_number: settlement.rekening,
                amount: 35_000,
                bank_reference: `REFC-${String(base)}`,
              },
            ],
          },
        ),
      );
      record(
        'POST /register',
        await call(
          { port: KONG_PORT, path: '/register', tls: true },
          {
            nik: registration.nik,
            nama: registration.nama,
            hp: registration.hp,
            email: registration.email,
            rekening: registration.rekening,
            username: `uji.tutup.${String(base + 1)}`,
          },
        ),
      );
      record(
        'POST /reconciliation/audit-request',
        await edge(
          '/reconciliation/audit-request',
          { authorization: `Bearer ${auditor}` },
          { transaction_id: transactionId, reason_code: 'DISPUTE' },
        ),
      );
    };

    it('M6-04 Privacy stopped: every route that needs it answers 503 in the ADR-0008 shape, and it comes back', async () => {
      docker(['stop', PRIVACY]);
      try {
        await routes('stopped');
      } finally {
        docker(['start', PRIVACY]);
      }
      const startedAt = Date.now();
      const healthy = await secondsUntilHealthy();
      let firstPaymentAfter = -1;
      for (let i = 0; i < 60 && firstPaymentAfter < 0; i += 1) {
        const again = await edge(
          '/transaction',
          { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
          {
            source_account: known.rekening,
            merchant_id: 'MRC-001',
            amount: 36_000,
            geohash: 'qqgu4',
          },
        );
        if (again.status === 201) firstPaymentAfter = (Date.now() - startedAt) / 1000;
        else await wait(1000);
      }
      report['recoveryAfterStop'] = {
        secondsUntilHealthy: healthy,
        secondsUntilFirstPaymentPassed: firstPaymentAfter,
        note: 'wall clock of this laptop; not a performance claim',
      };
      expect(firstPaymentAfter).toBeGreaterThan(0);
    }, 300_000);

    it('M6-04 Privacy paused (alive, not answering): the same routes answer 503 and it recovers when unpaused', async () => {
      docker(['pause', PRIVACY]);
      try {
        await routes('paused');
      } finally {
        docker(['unpause', PRIVACY]);
      }
      const again = await edge(
        '/transaction',
        { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        {
          source_account: known.rekening,
          merchant_id: 'MRC-001',
          amount: 37_000,
          geohash: 'qqgu4',
        },
      );
      report['recoveryAfterPause'] = { paymentAfterUnpauseStatus: again.status };
      expect(again.status).toBe(201);
    }, 300_000);

    it('M6-04 nothing real reached a service, a database, a log or a response during the outage', async () => {
      const payload = await observerScan(everyCanary);
      const leaks: string[] = payload.findings.map((f) => `${f.service}/${f.attribute}/payload`);
      const scanned: Record<string, number> = {};
      for (const service of ['transaction', 'fraud', 'notification', 'reconciliation']) {
        const dump = pgDump(service);
        scanned[`db:${service}`] = dump.length;
        for (const f of scanText(dump, everyCanary, { service, location: 'database' }))
          leaks.push(`${service}/${f.attribute}/database`);
        const log = containerLogs(containerOf(`${service}-service`));
        for (const f of scanText(log, everyCanary, { service, location: 'log' }))
          leaks.push(`${service}/${f.attribute}/log`);
      }
      for (const name of ['kong', 'gateway', 'privacy-service', 'keycloak']) {
        for (const f of scanText(containerLogs(containerOf(name)), everyCanary, {
          service: name,
          location: 'log',
        }))
          leaks.push(`${name}/${f.attribute}/log`);
      }
      // The registration saga compensates: no user is left in the IdP for the registration that failed.
      const idp = await tokenFor({ client: 'idp-admin', secretFile: 'idp-admin_client_secret' });
      const users = await fetch(
        `http://127.0.0.1:${process.env['IDP_HOST_PORT'] ?? '8080'}/admin/realms/privpay/users?username=uji.tutup.${String(base + 1)}&exact=true`,
        { headers: { authorization: `Bearer ${idp}` } },
      );
      const left = (await users.json()) as unknown[];
      report['outage'] = {
        attempts,
        everyAttemptIs503InTheOneShape: attempts.every(
          (a) => a.status === 503 && a.shapeOk && a.codeOk,
        ),
        anyResponseCarriesAValue: attempts.some((a) => a.responseCarriesValue),
        leaksFound: leaks,
        keycloakUsersLeftByTheFailedRegistration: left.length,
        scannedDumpCharacters: scanned,
        exchangesSeenByObserver: payload.exchanges,
        notTested:
          'Privacy slow but answering (no ticket); replicas (E-12); behavior under load (M7)',
      };
      // The control above was planted on purpose, so it is the one finding the observer may hold for the payment canary.
      const unexpected = leaks.filter((entry) => entry !== 'transaction/rekening/payload');
      expect(unexpected).toEqual([]);
      expect(left).toHaveLength(0);
      expect(
        attempts.every((a) => a.status === 503 && a.shapeOk && a.codeOk && !a.responseCarriesValue),
      ).toBe(true);
    });
  });
} else {
  describe('M6-04 baseline has no Privacy Service', () => {
    it('M6-04 not applicable in baseline: recorded as such', () => {
      report['outage'] = {
        applicable: false,
        reason: 'baseline has no Privacy Service (ADR-0003, N-47); there is nothing to switch off',
      };
      expect(PROJECT).toBe('privpay-baseline');
    });
  });
}

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
      requirement: 'TK-16, NFR-11, invariant 8, ADR-0008',
    },
    ...report,
  };
  writeFileSync(join(OUT, `tutup-${MODE}.json`), `${JSON.stringify(full, null, 2)}\n`);
});
