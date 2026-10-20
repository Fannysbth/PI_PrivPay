import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import { probe, probeAll, type Connect } from './tcp-probe';

// A probe says what a TCP connection to an address does: it connects, it is refused, or nothing answers in time.
describe('M0-06 tcp probe tells connected, refused and no answer apart, and never leaves a socket open', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const open = server;
    server = undefined;
    if (open?.listening === true) {
      await new Promise<void>((resolve) => {
        open.close(() => {
          resolve();
        });
      });
    }
  });

  const listen = async (): Promise<number> => {
    server = createServer((socket) => {
      socket.end();
    });
    const created = server;
    await new Promise<void>((resolve) => {
      created.listen(0, '127.0.0.1', resolve);
    });
    const address = created.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  };

  it('M0-06 a listening address is connected', async () => {
    expect(await probe('127.0.0.1', await listen(), { timeoutMs: 1000 })).toBe('connected');
  });

  it('M0-06 an address nobody listens on is refused', async () => {
    const port = await listen();
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    expect(await probe('127.0.0.1', port, { timeoutMs: 1000 })).toBe('refused');
  });

  /** A socket that does whatever the test says, and records that it was destroyed. */
  const fake = (
    script: (socket: EventEmitter) => void,
  ): { connect: Connect; destroyed: () => number; started: () => number } => {
    let destroyed = 0;
    let started = 0;
    const connect: Connect = () => {
      started += 1;
      const socket = Object.assign(new EventEmitter(), {
        destroy: () => {
          destroyed += 1;
        },
      });
      setImmediate(() => {
        script(socket);
      });
      return socket;
    };
    return { connect, destroyed: () => destroyed, started: () => started };
  };

  it('M0-06 an address that never answers is "no answer" after the time given, and the socket is destroyed', async () => {
    const socket = fake(() => undefined);
    expect(await probe('10.0.0.1', 9, { timeoutMs: 30, connect: socket.connect })).toBe(
      'no answer',
    );
    expect(socket.destroyed()).toBe(1);
  });

  it.each([
    ['ECONNREFUSED', 'refused'],
    ['ECONNRESET', 'error ECONNRESET'],
    ['EHOSTUNREACH', 'error EHOSTUNREACH'],
  ])('M0-06 the error %s is reported as %s', async (code, expected) => {
    const socket = fake((s) => s.emit('error', Object.assign(new Error('x'), { code })));
    expect(await probe('10.0.0.1', 9, { timeoutMs: 1000, connect: socket.connect })).toBe(expected);
    expect(socket.destroyed()).toBe(1);
  });

  it('M0-06 a connection is destroyed once it is seen, and a late timer does nothing', async () => {
    const socket = fake((s) => s.emit('connect'));
    expect(await probe('10.0.0.1', 9, { timeoutMs: 20, connect: socket.connect })).toBe(
      'connected',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(socket.destroyed()).toBe(1);
  });

  it('M0-06 probeAll starts every probe before any finishes, so many slow refusals cost the time of one', async () => {
    const hosts = ['a', 'b', 'c', 'd', 'e'];
    const socket = fake(() => undefined);
    const pending = probeAll(hosts, 9, { timeoutMs: 50, connect: socket.connect });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.started()).toBe(hosts.length);
    const result = await pending;
    expect(result).toEqual({
      a: 'no answer',
      b: 'no answer',
      c: 'no answer',
      d: 'no answer',
      e: 'no answer',
    });
  });
});
