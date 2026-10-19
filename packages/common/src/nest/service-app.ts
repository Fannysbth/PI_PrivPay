import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  Catch,
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Module,
  type ArgumentsHost,
  type DynamicModule,
  type ExceptionFilter,
  type INestApplication,
  type ModuleMetadata,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { SystemClock, type Clock } from '../clock';
import { loadConfig } from '../config';
import { RealDelay, type Delay } from '../delay';
import { DomainError, toClientError, toWireError, type Reason } from '../errors';
import { createLogger, type Logger } from '../logger';
import { HttpMetrics, routeLabel } from './metrics';
import { serviceConfigSchema, type ServiceId } from './service-config';

export interface ServiceDefinition {
  readonly service: ServiceId;
  /** The service's own modules (controllers and providers); the platform ones are added here. */
  readonly modules?: NonNullable<ModuleMetadata['imports']>;
}

/** Everything a test (or a later ticket) may replace; production uses the defaults. */
export interface ServiceDependencies {
  readonly clock?: Clock;
  /** Waits out the shutdown timeout; injected so tests never sleep for real. */
  readonly delay?: Delay;
  readonly logDestination?: { write(line: string): void };
  /** Pools and similar resources, closed in order once the last request has finished (qa E-08). */
  readonly closeables?: readonly { close(): Promise<void> }[];
}

export interface ServiceApp {
  readonly app: INestApplication;
  /** The underlying HTTP server, for tests that drive it without listening. */
  readonly httpServer: Server;
  /** Binds to the configured loopback address (AZ-43) and returns where it listens. */
  listen(): Promise<{ host: string; port: number }>;
  /** Stops accepting connections, lets running requests finish (up to the timeout), then closes the resources. */
  close(): Promise<void>;
}

const SERVICE_INFO = Symbol('SERVICE_INFO');
const CLOCK = Symbol('CLOCK');
const METRICS = Symbol('METRICS');

interface ServiceInfo {
  readonly service: ServiceId;
  readonly mode: string;
}

@Controller()
class HealthController {
  constructor(
    @Inject(SERVICE_INFO) private readonly info: ServiceInfo,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('health')
  health(): { status: 'ok'; service: ServiceId; mode: string; time: string } {
    return {
      status: 'ok',
      service: this.info.service,
      mode: this.info.mode,
      time: this.clock.now().toISOString(),
    };
  }
}

@Controller()
class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: HttpMetrics) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return this.metrics.render();
  }
}

@Module({})
class ServiceRootModule {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only the gateway answers external clients (ADR-0008); the others answer other services. */
const EXTERNAL: ReadonlySet<ServiceId> = new Set<ServiceId>(['gateway']);

const statusOf = (error: unknown): number | undefined => {
  if (error instanceof HttpException) return error.getStatus();
  if (typeof error === 'object' && error !== null) {
    // Express middleware such as the body parser reports its status this way.
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
};

/** Nothing about the failure is forwarded: the error's text could hold a SQL fragment or a value (S-42). */
function reasonFor(error: unknown): Reason {
  if (error instanceof DomainError) return error.reason;
  const status = statusOf(error);
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN_ROLE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  // Malformed body, unknown route, wrong method, too large: the caller sent something we do not accept.
  if (status !== undefined && status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

function respond(error: unknown, res: Response, external: boolean): void {
  const requestId =
    typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : randomUUID();
  const reason = reasonFor(error);
  res.locals['reason'] = reason;
  const { status, body } = (external ? toClientError : toWireError)(
    new DomainError(reason),
    requestId,
  );
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json(body);
}

@Catch()
class ServiceExceptionFilter implements ExceptionFilter {
  constructor(private readonly external: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    respond(exception, host.switchToHttp().getResponse<Response>(), this.external);
  }
}

/**
 * The shared skeleton of every service: validated environment, health and metrics, uniform errors, one log line per
 * request, loopback binding and graceful shutdown. It does not listen until `listen()` is called.
 */
export async function createServiceApp(
  definition: ServiceDefinition,
  env: Readonly<Record<string, string | undefined>>,
  dependencies: ServiceDependencies = {},
): Promise<ServiceApp> {
  const config = loadConfig(serviceConfigSchema, env);
  const clock = dependencies.clock ?? new SystemClock();
  const delay = dependencies.delay ?? new RealDelay();
  const closeables = dependencies.closeables ?? [];
  const logger: Logger = createLogger({
    service: definition.service,
    level: config.LOG_LEVEL,
    destination: dependencies.logDestination,
  });
  const metrics = new HttpMetrics();
  const external = EXTERNAL.has(definition.service);
  let closing = false;

  const root: DynamicModule = {
    module: ServiceRootModule,
    imports: [...(definition.modules ?? [])],
    controllers: [HealthController, MetricsController],
    providers: [
      {
        provide: SERVICE_INFO,
        useValue: { service: definition.service, mode: config.PRIVACY_MODE },
      },
      { provide: CLOCK, useValue: clock },
      { provide: METRICS, useValue: metrics },
    ],
  };
  const app = await NestFactory.create(root, { logger: false, abortOnError: false });

  // Request id and timing come first so that even errors raised by the body parser carry them.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const supplied = req.header('x-request-id');
    const requestId = supplied !== undefined && UUID.test(supplied) ? supplied : randomUUID();
    res.locals['requestId'] = requestId;
    res.setHeader('x-request-id', requestId);
    // A connection that outlives the shutdown would keep the server from draining.
    if (closing) res.setHeader('connection', 'close');

    const started = performance.now();
    res.on('finish', () => {
      const route = routeLabel((req as { route?: { path?: unknown } }).route?.path);
      const seconds = (performance.now() - started) / 1000;
      metrics.record(req.method, route, res.statusCode, seconds);
      const fields = {
        request_id: requestId,
        route,
        status: res.statusCode,
        latency_ms: Math.round(seconds * 1000),
      };
      const reason: unknown = res.locals['reason'];
      const logged = typeof reason === 'string' ? { ...fields, reason } : fields;
      if (res.statusCode >= 500) logger.error('http_request', logged);
      else logger.info('http_request', logged);
    });
    next();
  });
  app.useGlobalFilters(new ServiceExceptionFilter(external));
  await app.init();
  // After init, so it also catches what the body parser and other middleware raise before Nest's pipeline.
  const express = app.getHttpAdapter().getInstance() as { use(handler: ErrorRequestHandler): void };
  // Express recognises an error handler by its four parameters, so the last one must stay.
  express.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    respond(error, res, external);
  });

  const server = app.getHttpServer() as Server;
  let shutdown: Promise<void> | undefined;

  const stop = async (): Promise<void> => {
    closing = true;
    const failures: unknown[] = [];
    if (server.listening) {
      const drained = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server.closeIdleConnections();
      const outcome = await Promise.race([
        drained.then(() => 'drained' as const),
        delay.wait(config.SHUTDOWN_TIMEOUT_MS).then(() => 'timeout' as const),
      ]);
      if (outcome === 'timeout') {
        server.closeAllConnections();
        await drained;
      }
    }
    for (const resource of closeables) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await app.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new Error('shutdown: a resource failed to close', {
        cause: new AggregateError(failures),
      });
    }
  };

  return {
    app,
    httpServer: server,
    async listen() {
      await app.listen(config.PORT, config.BIND_HOST);
      const address = server.address() as AddressInfo;
      return { host: address.address, port: address.port };
    },
    close() {
      shutdown ??= stop();
      return shutdown;
    },
  };
}
