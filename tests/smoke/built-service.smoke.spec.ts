import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { SERVICE_IDS } from '../../packages/common/src/nest';

// These run the BUILT output as real processes (N-04: `tsc` builds to dist, `node dist/main.js` runs the service).
// `pnpm test:smoke` builds first. They are not part of `pnpm test`, which needs no build.
const root = join(__dirname, '..', '..');

const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
};

interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
}

const start = (entry: string, env: Record<string, string>): Running => {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
  return { child, output: () => text, exited };
};

/** Polls /health until the service answers or the process dies. Real waiting is unavoidable with a real process; it is bounded. */
const waitForHealth = async (port: number, running: Running): Promise<unknown> => {
  const state = { exited: false };
  void running.exited.then(() => {
    state.exited = true;
  });
  for (let attempt = 0; attempt < 300 && !state.exited; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet: the next attempt tries again after a short wait.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`service did not answer /health. output so far:\n${running.output()}`);
};

describe.each(SERVICE_IDS)('N-04 the built %s runs as a process', (id) => {
  const entry = join('services', id, 'dist', 'main.js');

  it('N-04 node dist/main.js serves /health on loopback and stops on SIGTERM with exit code 0', async () => {
    const port = await freePort();
    const running = start(entry, { PRIVACY_MODE: 'baseline', PORT: String(port) });
    try {
      const health = await waitForHealth(port, running);
      expect(health).toMatchObject({ status: 'ok', service: id, mode: 'baseline' });
    } finally {
      if (process.platform === 'win32') {
        // Windows delivers no SIGTERM to a child: kill() ends it at once. The graceful path is proven on Linux (CI).
        running.child.kill();
        await running.exited;
      } else {
        running.child.kill('SIGTERM');
        expect(await running.exited).toBe(0);
      }
    }
  });

  it('N-04 node dist/main.js refuses to start without PRIVACY_MODE and names the variable only', async () => {
    const running = start(entry, { PORT: '0', SOME_FAKE_VALUE: 'fake-value-do-not-print' });
    expect(await running.exited).toBe(1);
    expect(running.output()).toContain('PRIVACY_MODE (missing)');
    expect(running.output()).not.toContain('fake-value-do-not-print');
  });
});
