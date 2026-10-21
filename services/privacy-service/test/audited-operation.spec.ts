import { DomainError } from '@privpay/common';
import type { Pool } from 'pg';
import { AuditWriter, AuditedOperation } from '../src/audit';

// A connection that cannot even roll back is a failure of the connection, not of the database rules, so a stub
// client is enough here; the transaction semantics themselves are tested on PostgreSQL in audit.integration.spec.ts.
function brokenClient(): { pool: Pool; release: jest.Mock } {
  const release = jest.fn();
  const client = {
    query: jest.fn((sql: string) =>
      sql.startsWith('INSERT') || sql === 'ROLLBACK'
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve({ rows: [] }),
    ),
    release,
  };
  return { pool: { connect: () => Promise.resolve(client) } as unknown as Pool, release };
}

describe('M2-04 FR-13 a connection that cannot roll back', () => {
  it('M2-04 FR-13 fails with INTERNAL_ERROR, not a raw driver error, and is destroyed instead of reused', async () => {
    const { pool, release } = brokenClient();
    const operation = new AuditedOperation(pool, new AuditWriter());
    const outcome = operation.run(() =>
      Promise.resolve({
        result: null,
        audit: {
          action: 'GENERATE_TOKEN',
          status: 'SUCCESS',
          reason: 'OK',
          requestingService: 'API_GATEWAY',
        },
      }),
    );
    await expect(outcome).rejects.toBeInstanceOf(DomainError);
    await expect(outcome).rejects.toMatchObject({ reason: 'INTERNAL_ERROR' });
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});
