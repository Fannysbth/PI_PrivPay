import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// M7-E: the one-shot upload listener on the runner (A), the single command printed for the second laptop (B), the resource window
// reliability flag and the memory gate. Real loopback sockets, no real sleeps (the timeout and the memory wait use injected clocks).
const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

interface Done {
  status: string;
  receivedAt?: string;
}
interface Listener {
  token: string;
  port: number;
  address: string;
  done: Promise<Done>;
  close: () => Promise<void>;
}
type Timer = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS runner modules (like scripts/perf/plan.cjs)
const upload = require('../../scripts/perf/upload.cjs') as {
  startUploadListener: (o: Record<string, unknown>) => Promise<Listener>;
  validateSummary: (v: unknown, mode: string) => string | undefined;
  remoteCommand: (o: Record<string, unknown>) => string;
  uploadSettings: (o: Record<string, unknown>) => {
    peerIp: string;
    port: number;
    timeoutMs: number;
    bDir: string;
  };
  waitForFreeMemory: (o: Record<string, unknown>) => Promise<{
    ok: boolean;
    freeGB: number;
    waitedSeconds: number;
    message?: string;
  }>;
  MAX_BYTES: number;
  DEFAULT_TIMEOUT_MS: number;
  MIN_FREE_BYTES: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS runner module
const plan = require('../../scripts/perf/plan.cjs') as {
  resourceWindow: (lagSeconds: number | null | undefined) => { reliable: boolean };
  k6DockerArgs: (o: Record<string, unknown>) => string[];
};

const GOOD = {
  mode: 'proposed',
  endedAt: '2026-11-03T12:46:36.194Z',
  metrics: { 'http_reqs{scenario:measure,target:kong}': { count: 10 } },
};

const dirs: string[] = [];
const listeners: Listener[] = [];
afterEach(async () => {
  for (const l of listeners.splice(0)) await l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(extra: Record<string, unknown> = {}): Promise<{ l: Listener; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'privpay-upload-test-'));
  dirs.push(dir);
  const out = join(dir, 'k6-summary.json');
  const l = await upload.startUploadListener({
    host: '127.0.0.1',
    port: 0,
    peerIp: '127.0.0.1',
    expectedMode: 'proposed',
    outFile: out,
    timeoutMs: 60_000,
    ...extra,
  });
  listeners.push(l);
  return { l, out };
}

function send(
  port: number,
  path: string,
  body: string | Buffer,
  method = 'PUT',
  host = '127.0.0.1',
  token?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    // The token travels in a header, never in the path (CLAUDE.md: no secret in a URL).
    const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
    const req = request({ host, port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0); // the status is what counts; a close after it is not an error
    });
    req.on('error', (e) => {
      reject(e);
    });
    req.end(body);
  });
}

describe('M7-E upload listener', () => {
  it('M7-E accepts exactly one valid PUT, writes the file and closes the listener', async () => {
    const { l, out } = await start();
    expect(await send(l.port, '/upload', JSON.stringify(GOOD), 'PUT', '127.0.0.1', l.token)).toBe(
      200,
    );
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(GOOD);
    expect((await l.done).status).toBe('received');
  });

  it('M7-E refuses a second upload after the first one succeeded', async () => {
    const { l, out } = await start();
    expect(await send(l.port, '/upload', JSON.stringify(GOOD), 'PUT', '127.0.0.1', l.token)).toBe(
      200,
    );
    await l.done;
    const other = { ...GOOD, endedAt: '2026-11-03T13:00:00.000Z' };
    await expect(
      send(l.port, '/upload', JSON.stringify(other), 'PUT', '127.0.0.1', l.token),
    ).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    expect((JSON.parse(readFileSync(out, 'utf8')) as typeof GOOD).endedAt).toBe(GOOD.endedAt);
  });

  it('M7-E rejects a wrong token and keeps waiting for the right one', async () => {
    const { l, out } = await start();
    const wrong = `${l.token.slice(0, -1)}${l.token.endsWith('0') ? '1' : '0'}`;
    const body = JSON.stringify(GOOD);
    // A wrong or missing token is 401; the token is only read from the Authorization header.
    expect(await send(l.port, '/upload', body, 'PUT', '127.0.0.1', wrong)).toBe(401);
    expect(await send(l.port, '/upload', body)).toBe(401);
    // Another path is 404 whatever the token; a token in the path is not a credential any more.
    expect(await send(l.port, '/other', body, 'PUT', '127.0.0.1', l.token)).toBe(404);
    expect(await send(l.port, `/upload/${l.token}`, body)).toBe(404);
    expect(await send(l.port, `/upload/${l.token}`, body, 'PUT', '127.0.0.1', l.token)).toBe(404);
    expect(existsSync(out)).toBe(false);
    expect(await send(l.port, '/upload', JSON.stringify(GOOD), 'PUT', '127.0.0.1', l.token)).toBe(
      200,
    );
  });

  it('M7-E rejects a peer address other than --peer-ip', async () => {
    const { l, out } = await start({ peerIp: '127.0.0.2' });
    expect(await send(l.port, '/upload', JSON.stringify(GOOD), 'PUT', '127.0.0.1', l.token)).toBe(
      403,
    );
    expect(existsSync(out)).toBe(false);
  });

  it('M7-E rejects a method other than PUT', async () => {
    const { l, out } = await start();
    for (const m of ['POST', 'GET', 'DELETE'])
      expect(await send(l.port, '/upload', m === 'GET' ? '' : '{}', m, '127.0.0.1', l.token)).toBe(
        405,
      );
    expect(existsSync(out)).toBe(false);
  });

  it('M7-E rejects a body above 1 MiB', async () => {
    const { l, out } = await start();
    expect(upload.MAX_BYTES).toBe(1024 * 1024);
    const big = Buffer.alloc(upload.MAX_BYTES + 1, 0x20);
    expect(await send(l.port, '/upload', big, 'PUT', '127.0.0.1', l.token)).toBe(413);
    expect(existsSync(out)).toBe(false);
    expect(await send(l.port, '/upload', JSON.stringify(GOOD), 'PUT', '127.0.0.1', l.token)).toBe(
      200,
    );
  });

  it('M7-E rejects a body that is not valid JSON', async () => {
    const { l, out } = await start();
    expect(await send(l.port, '/upload', '{not json', 'PUT', '127.0.0.1', l.token)).toBe(400);
    expect(existsSync(out)).toBe(false);
  });

  it('M7-E rejects JSON without the metrics the runner expects (or for the other mode)', async () => {
    const { l, out } = await start();
    for (const bad of [
      {},
      [],
      { ...GOOD, mode: 'baseline' },
      { ...GOOD, endedAt: 'yesterday' },
      { ...GOOD, metrics: {} },
      { ...GOOD, metrics: [] },
      { mode: 'proposed', endedAt: GOOD.endedAt },
    ])
      expect(await send(l.port, '/upload', JSON.stringify(bad), 'PUT', '127.0.0.1', l.token)).toBe(
        422,
      );
    expect(existsSync(out)).toBe(false);
    expect(upload.validateSummary(GOOD, 'proposed')).toBeUndefined();
    expect(upload.validateSummary(GOOD, 'baseline')).toBeDefined();
  });

  it('M7-E answers 500 when the file cannot be stored, keeps the token and the runner alive', async () => {
    const { l, out } = await start();
    const inside = join(
      tmpdir(),
      `privpay-upload-missing-${l.token.slice(0, 8)}`,
      'k6-summary.json',
    );
    const broken = await start({ outFile: inside });
    expect(
      await send(
        broken.l.port,
        '/upload',
        JSON.stringify(GOOD),
        'PUT',
        '127.0.0.1',
        broken.l.token,
      ),
    ).toBe(500);
    mkdirSync(join(inside, '..'));
    dirs.push(join(inside, '..'));
    expect(
      await send(
        broken.l.port,
        '/upload',
        JSON.stringify(GOOD),
        'PUT',
        '127.0.0.1',
        broken.l.token,
      ),
    ).toBe(200);
    expect(existsSync(inside)).toBe(true);
    expect(existsSync(out)).toBe(false);
  });

  it('M7-E closes the listener when the timeout fires, with the default of 15 minutes', async () => {
    expect(upload.DEFAULT_TIMEOUT_MS).toBe(15 * 60 * 1000);
    let fire: (() => void) | undefined;
    let ms = 0;
    const timer: Timer = {
      set: (fn, m) => {
        fire = fn;
        ms = m;
        return 1;
      },
      clear: () => undefined,
    };
    const { l } = await start({ timeoutMs: 1234, timer });
    expect(ms).toBe(1234);
    fire?.();
    expect((await l.done).status).toBe('timeout');
    await expect(
      send(l.port, '/upload', JSON.stringify(GOOD), 'PUT', '127.0.0.1', l.token),
    ).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('M7-E binds only to the given address, not to every interface', async () => {
    const { l } = await start();
    expect(l.address).toBe('127.0.0.1');
    await expect(
      send(l.port, '/upload', JSON.stringify(GOOD), 'PUT', '127.0.0.2', l.token),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('M7-E uses a random single-use token of 192 bits, different per listener', async () => {
    const a = await start();
    const b = await start();
    expect(a.l.token).toMatch(/^[0-9a-f]{48}$/);
    expect(a.l.token).not.toBe(b.l.token);
  });

  it('M7-E refuses a missing host (no default, never 0.0.0.0)', async () => {
    for (const host of [undefined, '', '0.0.0.0', '::'])
      await expect(
        upload.startUploadListener({
          host,
          port: 0,
          peerIp: '127.0.0.1',
          expectedMode: 'proposed',
          outFile: join(tmpdir(), 'never-written.json'),
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(/host/);
  });
});

describe('M7-E settings', () => {
  it('M7-E needs a private IPv4 --peer-ip, takes the port from SUMMARY_UPLOAD_PORT (default 4444)', () => {
    const base = { peerIp: '192.168.1.30', env: {}, timeout: undefined, bDir: undefined };
    expect(upload.uploadSettings(base)).toMatchObject({ peerIp: '192.168.1.30', port: 4444 });
    expect(upload.uploadSettings({ ...base, env: { SUMMARY_UPLOAD_PORT: '5555' } }).port).toBe(
      5555,
    );
    for (const bad of [undefined, '', '0.0.0.0', '127.0.0.1', 'host', '8.8.8.8'])
      expect(() => upload.uploadSettings({ ...base, peerIp: bad })).toThrow(RangeError);
    for (const port of ['0', '80', 'abc', '70000', '4443', '8080'])
      expect(() => upload.uploadSettings({ ...base, env: { SUMMARY_UPLOAD_PORT: port } })).toThrow(
        RangeError,
      );
  });

  it('M7-E the timeout defaults to 15 minutes and can be set', () => {
    const base = { peerIp: '10.0.0.9', env: {}, bDir: undefined };
    expect(upload.uploadSettings({ ...base, timeout: undefined }).timeoutMs).toBe(900_000);
    expect(upload.uploadSettings({ ...base, timeout: '30m' }).timeoutMs).toBe(1_800_000);
    expect(() => upload.uploadSettings({ ...base, timeout: 'soon' })).toThrow(RangeError);
  });
});

describe('M7-E command for the second laptop', () => {
  const k6 = plan.k6DockerArgs({
    containerName: 'privpay-k6-run-proposed',
    caFile: 'C:\\k6test\\ca.crt',
    passwordFile: 'C:\\k6test\\password',
    scriptDir: 'C:\\k6test\\script',
    outDir: 'C:\\k6test\\out',
    mode: 'proposed',
    vus: 10,
    warmup: '0s',
    duration: '60s',
    pace: 'saturation',
    runBase: 1,
    kongAddr: '192.168.1.20:4443',
    idpAddr: '192.168.1.20:8080',
  });
  const cmd = upload.remoteCommand({
    k6Args: k6,
    bDir: 'C:\\k6test',
    ip: '192.168.1.20',
    port: 4444,
    token: 'a'.repeat(48),
  });

  it('M7-E is one line: docker run, then Invoke-RestMethod -Method Put -InFile to the upload URL', () => {
    expect(cmd).not.toMatch(/[\r\n]/);
    expect(cmd.startsWith('docker run')).toBe(false); // the stale summary is removed first
    expect(cmd).toContain('docker run --rm');
    expect(cmd).toContain('Invoke-RestMethod -Method Put -InFile C:\\k6test\\out\\k6-summary.json');
    expect(cmd).toContain('-Uri http://192.168.1.20:4444/upload');
    // The token is a header, not part of the URL (CLAUDE.md: no secret in a URL).
    expect(cmd).toContain(`-Headers @{Authorization='Bearer ${'a'.repeat(48)}'}`);
    expect(cmd).not.toContain(`/upload/${'a'.repeat(48)}`);
    expect(cmd.indexOf('Remove-Item')).toBeLessThan(cmd.indexOf('docker run'));
    expect(cmd.indexOf('docker run')).toBeLessThan(cmd.indexOf('Invoke-RestMethod'));
  });

  it('M7-E has no square brackets and no placeholder in angle brackets', () => {
    expect(cmd).not.toMatch(/[[\]<>]/);
  });

  it('M7-E uses C:\\k6test by default and refuses a folder that could break the command', () => {
    expect(
      upload.uploadSettings({ peerIp: '10.0.0.9', env: {}, timeout: undefined, bDir: undefined })
        .bDir,
    ).toBe('C:\\k6test');
    expect(
      upload.uploadSettings({ peerIp: '10.0.0.9', env: {}, timeout: undefined, bDir: 'D:\\x\\y' })
        .bDir,
    ).toBe('D:\\x\\y');
    for (const bad of ['k6test', 'C:\\my dir', 'C:\\a"b', 'C:\\a[1]', "C:\\a'b", 'C:\\a;b', 'C:\\'])
      expect(() =>
        upload.uploadSettings({ peerIp: '10.0.0.9', env: {}, timeout: undefined, bDir: bad }),
      ).toThrow(RangeError);
  });
});

describe('M7-E resource window reliability', () => {
  it('M7-E marks the window unreliable when the summary came more than 30 s after k6 ended', () => {
    expect(plan.resourceWindow(0).reliable).toBe(true);
    expect(plan.resourceWindow(30).reliable).toBe(true);
    expect(plan.resourceWindow(31).reliable).toBe(false);
    expect(plan.resourceWindow(360).reliable).toBe(false);
    expect(plan.resourceWindow(-31).reliable).toBe(false);
    expect(plan.resourceWindow(undefined).reliable).toBe(false);
    expect(plan.resourceWindow(Number.NaN).reliable).toBe(false);
  });

  it('M7-E the runner evaluates the window at k6.endedAt and records lag, flag and clock estimate', () => {
    const runner = read('scripts', 'perf', 'run.cjs');
    for (const t of [
      'resourcesWindowReliable',
      'summaryLagSeconds',
      'clockOffsetEstimateSeconds',
      'resourceWindow(',
      'waitForFreeMemory',
      'startUploadListener',
    ])
      expect(runner).toContain(t);
  });
});

describe('M7-E memory gate', () => {
  const GB = 1024 ** 3;
  function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it('M7-E passes at once with 3.5 GB or more and records the figure', async () => {
    expect(upload.MIN_FREE_BYTES).toBe(3.5 * GB);
    const r = await upload.waitForFreeMemory({ readFree: () => 3.5 * GB, ...clock() });
    expect(r).toMatchObject({ ok: true, freeGB: 3.5, waitedSeconds: 0 });
  });

  it('M7-E waits while below 3.5 GB and starts when memory is freed', async () => {
    const values = [1.57 * GB, 2 * GB, 4.2 * GB];
    const r = await upload.waitForFreeMemory({
      readFree: () => values.shift() ?? 4.2 * GB,
      ...clock(),
    });
    expect(r.ok).toBe(true);
    expect(r.freeGB).toBe(4.2);
    expect(r.waitedSeconds).toBeGreaterThan(0);
  });

  it('M7-E refuses to start after 5 minutes below 3.5 GB, with a clear message', async () => {
    const r = await upload.waitForFreeMemory({ readFree: () => 1.57 * GB, ...clock() });
    expect(r.ok).toBe(false);
    expect(r.waitedSeconds).toBeGreaterThanOrEqual(300);
    expect(r.waitedSeconds).toBeLessThan(310);
    expect(r.message).toMatch(/1\.57/);
    expect(r.message).toMatch(/3\.5/);
  });
});

describe('M7-E runbook and plan', () => {
  const book = read('docs', 'hasil', 'kinerja', 'RUNBOOK-dua-mesin.md');
  const rencana = read('docs', 'hasil', 'kinerja', 'RENCANA-RUN-RESMI.md');
  it('M7-E the upload rule is limited to A and B, removed at the end, with the reasons and the manual fallback', () => {
    expect(book).toMatch(/SUMMARY_UPLOAD_PORT/);
    expect(book).toMatch(
      /New-NetFirewallRule[^\n]*SUMMARY_UPLOAD_PORT|New-NetFirewallRule[^\n]*4444/,
    );
    expect(book).toMatch(/Remove-NetFirewallRule[^\n]*upload/);
    expect(book).toMatch(/tanpa TLS/);
    expect(book).toMatch(/sekali pakai/);
    expect(book).toMatch(/salin manual/i);
    expect(book).not.toMatch(/-RemoteAddress\s+(Any|\*|0\.0\.0\.0)/i);
  });
  it('M7-E the optional RTT step uses an ICMP echo rule from B only and 100 packets', () => {
    expect(book).toMatch(/ICMPv4/);
    expect(book).toMatch(/Remove-NetFirewallRule[^\n]*ping/);
    expect(book).toMatch(/ping -n 100/);
    expect(book).toMatch(/kabel|Ethernet/);
  });
  it('M7-E says Docker Desktop rule (com.docker.backend.exe) is disabled during the session and enabled again', () => {
    expect(book).toMatch(/com\.docker\.backend\.exe/);
    expect(book).toMatch(/Enable-NetFirewallRule/);
  });
  it('M7-E the plan notes closed-loop throughput depends on RTT, one session and one network, a cable on B', () => {
    expect(rencana).toMatch(/closed-loop/);
    expect(rencana).toMatch(/RTT/);
    expect(rencana).toMatch(/kabel/);
    expect(rencana).toMatch(/sesi dan jaringan yang sama/);
    expect(rencana).toMatch(/--peer-ip/);
  });
});
