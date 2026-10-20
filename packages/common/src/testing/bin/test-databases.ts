import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../../config';
import { pgConfigSchema } from '../../db';
import { createAdminPool } from '../test-db';
import { dropTestDatabases, listPrivpayDatabases, runTestDatabasesCli } from '../test-db-cleanup';

// `pnpm db:test-databases [list | drop]`: lists the privpay databases, and with `drop` removes the leftovers of
// integration tests after a typed confirmation. Host, port and secrets directory come from the environment like the
// tests (PG_HOST, PG_PORT, PG_SECRETS_DIR; `.env.test`). Never touches a service database.
async function main(): Promise<number> {
  const config = loadConfig(pgConfigSchema, process.env);
  const admin = createAdminPool(config);
  // No terminal, no confirmation: a pipe or a script can never answer the prompt.
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  try {
    return await runTestDatabasesCli(process.argv.slice(2), {
      store: {
        list: () => listPrivpayDatabases(admin),
        drop: (names) => dropTestDatabases(config, names),
      },
      ask: (prompt) => (rl === undefined ? Promise.resolve('') : rl.question(prompt)),
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    rl?.close();
    await admin.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only a category: a connection error message could carry the host or a role name.
    const code = (error as { code?: unknown } | null)?.code;
    process.stderr.write(`test-databases failed: ${typeof code === 'string' ? code : 'error'}\n`);
    process.exitCode = 1;
  },
);
