import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// N-50: every service that has a database of its own reaches it through `serviceDatabase`, with the suffix of its
// environment, so `dev:up` can run a mode on databases of its own. A module that names `db.database` straight would
// ignore the suffix and write into the real database of the other mode.
const ROOT = join(__dirname, '..', '..');
const MODULES = {
  transaction: 'services/transaction-service/src/transaction.module.ts',
  fraud: 'services/fraud-service/src/fraud.module.ts',
  notification: 'services/notification-service/src/notification.module.ts',
  reconciliation: 'services/reconciliation-service/src/reconciliation.module.ts',
} as const;

describe('N-50 the services with a baseline reach their database through serviceDatabase', () => {
  for (const [service, file] of Object.entries(MODULES)) {
    const source = readFileSync(join(ROOT, file), 'utf8');

    it(`N-50 ${service} names its database with the suffix of the environment`, () => {
      expect(source).toContain(`serviceDatabase('${service}', config.PG_DATABASE_SUFFIX)`);
    });

    it(`N-50 ${service} does not name the fixed database in a pool`, () => {
      expect(source).not.toMatch(/database:\s*db\.database/);
    });
  }
});
