import { ConfigError } from '../config';
import { createLogger } from '../logger';
import {
  createServiceApp,
  type ServiceApp,
  type ServiceDefinition,
  type ServiceDependencies,
} from './service-app';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface RunServiceOptions extends ServiceDependencies {
  /** Ends the process; replaced in tests so the runner itself is not terminated. */
  readonly exit?: (code: number) => void;
}

/**
 * The whole of a service's `main.ts`. A configuration problem or a port that cannot be bound stops the process with
 * the variable names or a reason only (fail fast); SIGTERM and SIGINT start the graceful shutdown. Resolves to the
 * running service, or to `undefined` when it did not start.
 */
export async function runService(
  definition: ServiceDefinition,
  options: RunServiceOptions = {},
): Promise<ServiceApp | undefined> {
  const { exit = (code: number): never => process.exit(code), ...dependencies } = options;
  // NFR-20: every timestamp is UTC. The schema refuses any other TZ, so this only fills the default in.
  process.env['TZ'] = 'UTC';
  const logger = createLogger({
    service: definition.service,
    destination: dependencies.logDestination,
  });

  let running: ServiceApp;
  try {
    running = await createServiceApp(definition, process.env, dependencies);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${definition.service}: ${error.message}\n`);
    } else {
      logger.error('startup_failed', { reason: 'INTERNAL_ERROR' });
    }
    process.exitCode = 1;
    return undefined;
  }

  const stopListening = (): void => {
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
  // One handler for both signals, removed as soon as it runs: a second signal must not start a second shutdown.
  function onSignal(): void {
    stopListening();
    running.close().then(
      () => {
        exit(0);
      },
      () => {
        logger.error('shutdown_failed', { reason: 'INTERNAL_ERROR' });
        exit(1);
      },
    );
  }
  for (const signal of SIGNALS) process.on(signal, onSignal);

  try {
    await running.listen();
  } catch {
    // The error text names the address and port; the reason is all that is logged.
    stopListening();
    logger.error('startup_failed', { reason: 'INTERNAL_ERROR' });
    process.exitCode = 1;
    await running.close().catch(() => undefined);
    return undefined;
  }
  logger.info('service_started');
  return running;
}
