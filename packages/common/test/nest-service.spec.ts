import 'reflect-metadata';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Controller, Get, Module, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import { FakeClock } from '../src/clock';
import { ConfigError } from '../src/config';
import { type Delay } from '../src/delay';
import { DomainError, RateLimitedError } from '../src/errors';
import { createServiceApp, SERVICE_IDS, type ServiceApp, type ServiceId } from '../src/nest';
import { capture } from './log-capture';

// Built at run time so no PSEU- literal sits in the repository (gitleaks allowlist covers docs/ and tests/ only).
const canary = ['PSEU', 'AB12CD34'].join('-');
const baseEnv = { PRIVACY_MODE: 'proposed', PORT: '0' };
const NEVER: Delay = { wait: () => new Promise<void>(() => undefined) };
// Resolves at once and records what it was asked to wait for.
const waits: number[] = [];
const IMMEDIATELY: Delay = {
  wait: (ms) => {
    waits.push(ms);
    return Promise.resolve();
  },
};

/** Polls (bounded, no sleeping) until `done()` holds; the events awaited here are already on their way. */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !done(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
// A fresh gate for every test: a gate that was opened once stays open.
let held = gate();
let reached: () => void = () => undefined;

@Controller('probe')
class ProbeController {
  @Get('domain')
  domain(): never {
    throw new DomainError('POLICY_NOT_ALLOWED');
  }

  // A catch-all route (the gateway) names the route it matched itself, so metrics keep a template per route.
  @Get('templated/:id')
  templated(@Param('id') id: string, @Res({ passthrough: true }) res: Response): { id: string } {
    res.locals['routeTemplate'] =
      id === 'hostile' ? '/probe/templated/12345678901234' : '/probe/templated/{id}';
    return { id };
  }

  @Get('limited')
  limited(): never {
    throw new RateLimitedError(17);
  }

  @Get('raw')
  raw(): never {
    throw new Error('SELECT secret FROM vault WHERE fake_marker = 1');
  }

  @Get('partial')
  partial(@Res() res: Response): never {
    // The status line and a first chunk are already on the wire when the failure happens.
    res.write('partial');
    throw new Error('failure after the headers were sent');
  }

  @Get('slow/:id')
  async slow(@Param('id') id: string): Promise<{ id: string }> {
    reached();
    await held.promise;
    return { id };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const open: ServiceApp[] = [];
async function start(
  service: ServiceId,
  extra: {
    env?: Record<string, string>;
    modules?: (typeof ProbeModule)[];
    delay?: Delay;
    closeables?: { close(): Promise<void> }[];
  } = {},
): Promise<{ service: ServiceApp; lines: string[] }> {
  const log = capture();
  const clock = new FakeClock(new Date('2026-10-19T08:00:00+07:00'));
  const created = await createServiceApp(
    { service, modules: extra.modules },
    { ...baseEnv, ...extra.env },
    {
      clock,
      logDestination: log.destination,
      delay: extra.delay ?? NEVER,
      closeables: extra.closeables,
    },
  );
  open.push(created);
  return { service: created, lines: log.lines };
}
beforeEach(() => {
  held = gate();
  reached = () => undefined;
  waits.length = 0;
});
afterEach(async () => {
  held.open();
  // allSettled: a test that checks a failing shutdown must not fail again here.
  await Promise.allSettled(open.splice(0).map((created) => created.close()));
});

describe.each(SERVICE_IDS)('M0-06 %s exposes /health and /metrics (NFR-14)', (id) => {
  it('M0-06 GET /health returns status, service, mode and the UTC time of the injected clock', async () => {
    const { service } = await start(id);
    const response = await request(service.httpServer).get('/health').expect(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: id,
      mode: 'proposed',
      time: '2026-10-19T01:00:00.000Z',
    });
  });

  it('M0-06 GET /metrics is Prometheus text with the request count and latency per route template', async () => {
    const { service } = await start(id);
    await request(service.httpServer).get('/health').expect(200);
    const response = await request(service.httpServer).get('/metrics').expect(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-type']).toContain('version=0.0.4');
    expect(response.text).toContain(
      'privpay_http_requests_total{method="GET",route="/health",status="200"} 1',
    );
    expect(response.text).toContain('privpay_http_request_duration_seconds_bucket{');
    expect(response.text).toContain('privpay_http_request_duration_seconds_count{');
  });
});

describe('M0-06 metrics and logs carry no value taken from the request (NFR-14, NFR-15)', () => {
  it('M0-06 a token in the path or query never becomes a metric label or a log field', async () => {
    const { service, lines } = await start('gateway', { modules: [ProbeModule] });
    const server = service.httpServer;
    await request(server).get(`/accounts/${canary}`).expect(422);
    await request(server).get(`/health?token=${canary}`).expect(200);
    held.open();
    await request(server)
      .get(`/probe/slow/${canary}`)
      .set('x-request-id', 'not-a-uuid')
      .expect(200);
    const metrics = (await request(server).get('/metrics')).text;
    expect(metrics).not.toContain(canary);
    expect(metrics).toContain('route="/unmatched"');
    expect(metrics).toContain('route="/probe/slow/{id}"');
    expect(lines.join('\n')).not.toContain(canary);
  });

  it('M0-06 each request writes one log line with only the allowed fields', async () => {
    const { service, lines } = await start('fraud-service');
    await request(service.httpServer).get('/health').expect(200);
    const entry = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(
      ['event', 'latency_ms', 'level', 'request_id', 'route', 'service', 'status', 'time'].sort(),
    );
    expect(entry).toMatchObject({ event: 'http_request', route: '/health', status: 200 });
  });
});

describe('M0-06 every failure has the same shape and leaks nothing (NFR-25, S-42)', () => {
  it('M0-06 an unknown route is a uniform error that echoes only a valid request id', async () => {
    const { service } = await start('transaction-service');
    const id = '0b9f3c8e-6a52-4a53-9f43-1f7b3d1f6a10';
    const known = await request(service.httpServer).get('/nope').set('x-request-id', id);
    expect(known.status).toBe(422);
    expect(known.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        reason: 'VALIDATION_ERROR',
        message: 'Permintaan tidak valid',
        request_id: id,
      },
    });
    const hostile = await request(service.httpServer)
      .get('/nope')
      .set('x-request-id', `${canary}<script>`);
    const returned = (hostile.body as { error: { request_id: string } }).error.request_id;
    expect(returned).toMatch(/^[0-9a-f-]{36}$/);
    expect(hostile.headers['x-request-id']).toBe(returned);
  });

  it('M0-06 a DomainError keeps its reason and status between services', async () => {
    const { service } = await start('privacy-service', { modules: [ProbeModule] });
    const response = await request(service.httpServer).get('/probe/domain');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { code: 'ACCESS_DENIED', reason: 'POLICY_NOT_ALLOWED' },
    });
  });

  it('M1-03 a route template chosen by the service is the metrics label, and a value that looks like data is not', async () => {
    const { service } = await start('gateway', { modules: [ProbeModule] });
    await request(service.httpServer).get('/probe/templated/abc').expect(200);
    await request(service.httpServer).get('/probe/templated/hostile').expect(200);
    const metrics = (await request(service.httpServer).get('/metrics')).text;
    expect(metrics).toContain('route="/probe/templated/{id}"');
    expect(metrics).toContain('route="/other"');
    expect(metrics).not.toContain('12345678901234');
  });

  it('M1-03 S-nn every answer says nosniff and none names the framework', async () => {
    const { service } = await start('transaction-service', { modules: [ProbeModule] });
    for (const path of ['/health', '/metrics', '/probe/domain', '/nope']) {
      const response = await request(service.httpServer).get(path);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('M1-03 a RateLimitedError is a 429 that says how long to wait (Retry-After)', async () => {
    const { service } = await start('gateway', { modules: [ProbeModule] });
    const response = await request(service.httpServer).get('/probe/limited');
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(Object.keys((response.body as { error: object }).error).sort()).toEqual([
      'code',
      'message',
      'request_id',
    ]);
  });

  it('M0-06 an unexpected error is a generic 500 without its text, stack or SQL, in the body and the log', async () => {
    const { service, lines } = await start('privacy-service', { modules: [ProbeModule] });
    const response = await request(service.httpServer).get('/probe/raw');
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    // Exactly the uniform fields: nothing like a stack, a cause or the original message can ride along.
    expect(Object.keys((response.body as { error: object }).error).sort()).toEqual([
      'code',
      'message',
      'reason',
      'request_id',
    ]);
    for (const text of [JSON.stringify(response.body), lines.join('\n')]) {
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain('fake_marker');
      expect(text).not.toContain('stack');
    }
  });

  it('M0-06 a malformed JSON body is a validation error, not a stack trace', async () => {
    const { service } = await start('notification-service');
    const response = await request(service.httpServer)
      .post('/health')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain('Unexpected');
  });
});

describe('M0-06 the environment is validated at start (fail fast, NFR-20)', () => {
  const failure = async (env: Record<string, string | undefined>): Promise<ConfigError> => {
    const merged: Record<string, string | undefined> = { ...baseEnv, ...env };
    const clean = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    try {
      await createServiceApp({ service: 'gateway' }, clean);
    } catch (error) {
      if (error instanceof ConfigError) return error;
      throw error;
    }
    throw new Error('expected the start to fail');
  };

  it('M0-06 a missing PRIVACY_MODE or PORT stops the start and names the variable', async () => {
    expect((await failure({ PRIVACY_MODE: undefined })).message).toContain(
      'PRIVACY_MODE (missing)',
    );
    expect((await failure({ PORT: undefined })).message).toContain('PORT (missing)');
  });

  it('M0-06 only baseline and proposed are accepted as the mode (ADR-0003)', async () => {
    expect((await failure({ PRIVACY_MODE: 'static' })).message).toContain('PRIVACY_MODE (invalid)');
  });

  it('M0-06 a time zone other than UTC is refused (NFR-20)', async () => {
    expect((await failure({ TZ: 'Asia/Jakarta' })).message).toContain('TZ (invalid)');
  });

  it('M0-06 a bind address that is not loopback is refused (AZ-43)', async () => {
    expect((await failure({ BIND_HOST: '0.0.0.0' })).message).toContain('BIND_HOST (invalid)');
  });

  it('M0-06 the message names variables only, never their values', async () => {
    const error = await failure({ PRIVACY_MODE: `static-${canary}` });
    expect(error.message).not.toContain(canary);
  });
});

/** The error code of a connection attempt, or 'connected'. */
function connectCode(host: string, port: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const req = httpRequest({ host, port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve('connected');
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'error');
    });
    req.end();
  });
}

describe.each(SERVICE_IDS)('M0-06 %s listens on loopback only (AZ-43)', (id) => {
  it('M0-06 binds 127.0.0.1 and refuses connections that arrive on any other local address', async () => {
    const { service } = await start(id);
    const { host, port } = await service.listen();
    expect(host).toBe('127.0.0.1');
    expect(await connectCode(host, port)).toBe('connected');

    // 127.0.0.2 is loopback too, but not the address the service is bound to: it exists on every machine, so this
    // check never passes vacuously. The machine's own addresses are tried as well when it has any.
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((net) => net !== undefined && net.family === 'IPv4' && !net.internal)
      .map((net) => net?.address ?? '');
    for (const address of ['127.0.0.2', ...external]) {
      expect(await connectCode(address, port)).toBe('ECONNREFUSED');
    }
  });

  it('M0-06 does not start without PRIVACY_MODE (fail fast)', async () => {
    await expect(createServiceApp({ service: id }, { PORT: '0' })).rejects.toThrow(
      'PRIVACY_MODE (missing)',
    );
  });
});

describe('M0-06 shutdown finishes running requests and closes the pools (qa E-08)', () => {
  it('M0-06 close() lets a running request finish, refuses new ones, then closes the pools once', async () => {
    const closed: string[] = [];
    const { service } = await start('sms-simulator', {
      modules: [ProbeModule],
      closeables: [
        {
          close: () => {
            closed.push('pool');
            return Promise.resolve();
          },
        },
      ],
    });
    const { host, port } = await service.listen();
    const base = `http://${host}:${String(port)}`;

    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const running = request(base)
      .get('/probe/slow/1')
      .then((response) => response);
    await arrived;

    const closing = service.close();
    await expect(request(base).get('/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(closed).toEqual([]);

    held.open();
    const response = await running;
    await closing;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: '1' });
    expect(closed).toEqual(['pool']);

    await service.close();
    expect(closed).toEqual(['pool']);
  });

  it('M0-06 a request that outlives the shutdown timeout is cut off and close() still completes', async () => {
    const closed: string[] = [];
    const { service } = await start('reconciliation-service', {
      modules: [ProbeModule],
      delay: IMMEDIATELY,
      closeables: [
        {
          close: () => {
            closed.push('pool');
            return Promise.resolve();
          },
        },
      ],
    });
    const { host, port } = await service.listen();
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const stuck = request(`http://${host}:${String(port)}`)
      .get('/probe/slow/2')
      .then(
        () => 'finished',
        () => 'cut off',
      );
    await arrived;
    await service.close();
    expect(await stuck).toBe('cut off');
    expect(closed).toEqual(['pool']);
    expect(waits).toEqual([10_000]);
  });

  it('M0-06 a pool that fails to close does not stop the others from closing', async () => {
    const closed: string[] = [];
    const { service } = await start('gateway', {
      closeables: [
        { close: () => Promise.reject(new Error('boom')) },
        {
          close: () => {
            closed.push('second');
            return Promise.resolve();
          },
        },
      ],
    });
    await service.listen();
    await expect(service.close()).rejects.toThrow('shutdown');
    expect(closed).toEqual(['second']);
  });

  it('M0-06 a request cut off by the shutdown is still logged and counted, as 499', async () => {
    const { service, lines } = await start('fraud-service', {
      modules: [ProbeModule],
      delay: IMMEDIATELY,
    });
    const { host, port } = await service.listen();
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const stuck = request(`http://${host}:${String(port)}`)
      .get('/probe/slow/3')
      .then(
        () => 'finished',
        () => 'cut off',
      );
    await arrived;
    await service.close();
    await stuck;
    await until(() => lines.join(' ').includes('"status":499'));
    expect(lines.join(' ')).toContain('"status":499');
    expect(lines.join(' ')).not.toContain('/probe/slow/3');
  });

  it('M0-06 a signal that arrives while the service is still starting does not leave it half stopped', async () => {
    const { service } = await start('gateway');
    const starting = service.listen();
    const closing = service.close();
    await starting;
    await closing;
    expect(service.httpServer.listening).toBe(false);
  });
});

describe('M0-06 a failure after the response started is not reported as a success', () => {
  it('M0-06 the connection is destroyed instead of ending the truncated body normally', async () => {
    const { service } = await start('transaction-service', { modules: [ProbeModule] });
    const { host, port } = await service.listen();
    const outcome = await new Promise<string>((resolve) => {
      const req = httpRequest({ host, port, path: '/probe/partial' }, (res) => {
        res.on('error', () => {
          resolve('aborted');
        });
        res.on('aborted', () => {
          resolve('aborted');
        });
        res.on('end', () => {
          resolve('ended normally');
        });
        res.resume();
      });
      req.on('error', () => {
        resolve('aborted');
      });
      req.end();
    });
    expect(outcome).toBe('aborted');
  });
});

describe('M1-01 a service may build its modules from the validated environment', () => {
  it('M1-01 the factory receives the environment and the clock, and what it returns is mounted', async () => {
    const seen: { port?: string; now?: string } = {};
    const clock = new FakeClock(new Date('2026-10-19T08:00:00+07:00'));
    const created = await createServiceApp(
      {
        service: 'dev-idp',
        modules: (context) => {
          seen.port = context.env['PORT'];
          seen.now = context.clock.now().toISOString();
          return [ProbeModule];
        },
      },
      baseEnv,
      { clock, logDestination: capture().destination },
    );
    open.push(created);
    expect(seen).toEqual({ port: '0', now: '2026-10-19T01:00:00.000Z' });
    await request(created.httpServer).get('/probe/domain').expect(403);
    const health = await request(created.httpServer).get('/health').expect(200);
    expect(health.body).toMatchObject({ service: 'dev-idp', status: 'ok' });
  });

  it('M1-01 a ConfigError raised by the factory stops the start, like the platform configuration does', async () => {
    const failure = createServiceApp(
      {
        service: 'dev-idp',
        modules: () => {
          throw new ConfigError([{ name: 'DEV_IDP_ENABLED', problem: 'invalid' }]);
        },
      },
      baseEnv,
    );
    await expect(failure).rejects.toThrow('DEV_IDP_ENABLED (invalid)');
  });

  it('M1-01 the factory is not called when the platform configuration is already wrong', async () => {
    let called = false;
    const failure = createServiceApp(
      {
        service: 'dev-idp',
        modules: () => {
          called = true;
          return [];
        },
      },
      { PORT: '0' },
    );
    await expect(failure).rejects.toThrow('PRIVACY_MODE (missing)');
    expect(called).toBe(false);
  });
});
