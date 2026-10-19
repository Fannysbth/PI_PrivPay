import { createServer, type Server } from 'node:net';
import { runService } from '../src/nest';
import { capture } from './log-capture';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

describe('M0-06 runService wires the process to the shared bootstrap', () => {
  // Individual keys are restored: replacing process.env itself would drop its special handling of TZ.
  const touched = ['PRIVACY_MODE', 'PORT', 'TZ', 'BIND_HOST', 'SOME_SECRET_LOOKING_VALUE'];
  const saved = new Map(touched.map((key) => [key, process.env[key]]));
  const occupied: Server[] = [];

  afterEach(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    for (const signal of SIGNALS) process.removeAllListeners(signal);
    process.exitCode = undefined;
    jest.restoreAllMocks();
    await Promise.all(
      occupied.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  it('M0-06 a missing PRIVACY_MODE sets exit code 1 and prints the variable name only', async () => {
    delete process.env['PRIVACY_MODE'];
    process.env['PORT'] = '0';
    process.env['SOME_SECRET_LOOKING_VALUE'] = 'fake-value-do-not-print';
    const written: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await runService({ service: 'fraud-service' });

    expect(process.exitCode).toBe(1);
    const text = written.join('');
    expect(text).toContain('fraud-service');
    expect(text).toContain('PRIVACY_MODE (missing)');
    expect(text).not.toContain('fake-value-do-not-print');
  });

  it('M0-06 forces TZ to UTC before anything reads a date (NFR-20)', async () => {
    delete process.env['PRIVACY_MODE'];
    process.env['TZ'] = 'Asia/Jakarta';
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runService({ service: 'gateway' });
    expect(process.env['TZ']).toBe('UTC');
  });

  it.each(SIGNALS)(
    'M0-06 %s stops the listener, closes the service and exits with 0 (qa E-08)',
    async (signal) => {
      process.env['PRIVACY_MODE'] = 'baseline';
      process.env['PORT'] = '0';
      const log = capture();
      const exits: number[] = [];
      const exited = new Promise<void>((resolve) => {
        const exit = (code: number): void => {
          exits.push(code);
          resolve();
        };
        void runService(
          { service: 'sms-simulator' },
          { exit, logDestination: log.destination },
        ).then((started) => {
          expect(started?.httpServer.listening).toBe(true);
          process.emit(signal);
        });
      });
      await exited;
      expect(exits).toEqual([0]);
      // Both handlers are gone once one of them has run, so a second signal cannot start a second shutdown.
      for (const name of SIGNALS) expect(process.listenerCount(name)).toBe(0);
    },
  );

  it('M0-06 a shutdown that fails exits with 1 and logs only the reason', async () => {
    process.env['PRIVACY_MODE'] = 'proposed';
    process.env['PORT'] = '0';
    const log = capture();
    const exits: number[] = [];
    const failing = { close: () => Promise.reject(new Error('fake-pool-detail')) };
    const exited = new Promise<void>((resolve) => {
      void runService(
        { service: 'fraud-service' },
        {
          exit: (code) => {
            exits.push(code);
            resolve();
          },
          logDestination: log.destination,
          closeables: [failing],
        },
      ).then(() => process.emit('SIGTERM'));
    });
    await exited;
    expect(exits).toEqual([1]);
    expect(log.lines.join(' ')).not.toContain('fake-pool-detail');
    expect(log.lines.join(' ')).toContain('shutdown_failed');
  });

  it('M0-06 a port that is already taken is a logged startup failure, not a raw stack', async () => {
    const busy = createServer();
    occupied.push(busy);
    await new Promise<void>((resolve) => {
      busy.listen(0, '127.0.0.1', resolve);
    });
    const address = busy.address();
    process.env['PRIVACY_MODE'] = 'proposed';
    process.env['PORT'] = String(
      typeof address === 'object' && address !== null ? address.port : 0,
    );
    const log = capture();

    const started = await runService({ service: 'gateway' }, { logDestination: log.destination });

    expect(started).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(log.lines.join(' ')).toContain('startup_failed');
    expect(log.lines.join(' ')).not.toContain('EADDRINUSE');
    for (const name of SIGNALS) expect(process.listenerCount(name)).toBe(0);
  });
});
