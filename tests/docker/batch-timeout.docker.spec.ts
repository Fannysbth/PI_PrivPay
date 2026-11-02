import { docker, edge, MODE, PROJECT } from './helpers';
import { ROLE_TOKENS, tokenFor } from '../measure/support';

// ADR-0018, through Kong on the running stack (both conditions): the one batch route, POST /reconciliation/run, waits for the
// Reconciliation Service longer than 3 s, and a route that is not a batch is still cut at 3 s (NFR-12). The slow downstream is
// the real Reconciliation container, paused for a few seconds (alive, accepting the connection, not answering).
// Real time is the point: the wait itself is what is under test. Dates are unique per run (the stack keeps its data).
const RECONCILIATION = `${PROJECT}-reconciliation-service-1`;
const day = (offset: number): string =>
  new Date(
    Date.UTC(2021, 0, 1) +
      (Math.floor(Date.now() / 1000) % 1000) * 86_400_000 +
      offset * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe(`ADR-0018 batch route timeout through Kong (${MODE})`, () => {
  afterEach(() => {
    // Whatever a test did, the container must not stay paused for the next one.
    try {
      docker(['unpause', RECONCILIATION]);
    } catch {
      /* it was not paused */
    }
  });

  it('ADR-0018 a route that is not a batch is cut at 3 s: 503 well before the 30 s of Kong', async () => {
    const auditor = await tokenFor(ROLE_TOKENS.auditor);
    docker(['pause', RECONCILIATION]);
    const started = Date.now();
    const answer = await edge(
      '/reconciliation/audit-request',
      { authorization: `Bearer ${auditor}` },
      { transaction_id: 'TX-1760860800000001', reason_code: 'DISPUTE' },
    );
    const seconds = (Date.now() - started) / 1000;
    docker(['unpause', RECONCILIATION]);
    expect(answer.status).toBe(503);
    expect(seconds).toBeGreaterThanOrEqual(2.5);
    expect(seconds).toBeLessThan(8);
  }, 60_000);

  it('ADR-0018 POST /reconciliation/run waits past 3 s for a slow Reconciliation and answers 200', async () => {
    const admin = await tokenFor(ROLE_TOKENS.admin);
    docker(['pause', RECONCILIATION]);
    const started = Date.now();
    const pending = edge(
      '/reconciliation/run',
      { authorization: `Bearer ${admin}` },
      { date: day(0) },
    );
    await wait(6000);
    docker(['unpause', RECONCILIATION]);
    const answer = await pending;
    const seconds = (Date.now() - started) / 1000;
    expect(answer.status).toBe(200);
    expect(seconds).toBeGreaterThanOrEqual(6);
  }, 90_000);
});
