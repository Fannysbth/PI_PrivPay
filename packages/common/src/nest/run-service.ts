import { ConfigError } from '../config';
import { createLogger } from '../logger';
import { createServiceApp, type ServiceDefinition } from './service-app';

/**
 * The whole of a service's `main.ts`. A configuration problem stops the process with the variable names only
 * (fail fast); SIGTERM and SIGINT start the graceful shutdown.
 */
export async function runService(definition: ServiceDefinition): Promise<void> {
  // NFR-20: every timestamp is UTC. The schema refuses any other TZ, so this only fills the default in.
  process.env['TZ'] = 'UTC';
  const logger = createLogger({ service: definition.service });

  let running;
  try {
    running = await createServiceApp(definition, process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${definition.service}: ${error.message}\n`);
    } else {
      logger.error('startup_failed', { reason: 'INTERNAL_ERROR' });
    }
    process.exitCode = 1;
    return;
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      running.close().then(
        () => {
          process.exit(0);
        },
        () => {
          logger.error('shutdown_failed', { reason: 'INTERNAL_ERROR' });
          process.exit(1);
        },
      );
    });
  }
  await running.listen();
  logger.info('service_started');
}
