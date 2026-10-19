// THROWAWAY: PRD 7.1 buat_token in three variants, to learn which is safe under concurrency.
//  A = PRD as written: SELECT ... FOR UPDATE, expire stale, find, INSERT (retry only on pseudonym collision)
//  B = A + retry the whole transaction when the partial unique index uq_mapping_active is violated
//  C = A + transaction-scoped advisory lock on (lookup, service, purpose) taken first
import { randomUUID } from 'node:crypto';
import { aadMapping, encryptField, subjectLookup, tokenValue } from './crypto.mjs';

const WHERE_COMBO = 'subject_lookup = $1 AND service_id = $2 AND purpose = $3';

export async function buatToken(pool, keys, req, { strategy, clock, tokenFn = tokenValue, keyVersion = 1 }) {
  const lookup = subjectLookup(keys.kIndex, req.subjectType, req.subjectId);
  const combo = [lookup, req.serviceId, req.purpose];
  for (let retry = 0; retry < 8; retry++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (strategy === 'C') {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`${lookup.toString('hex')}|${req.serviceId}|${req.purpose}`]);
      }
      const now = new Date(clock.now()).toISOString();
      await client.query(`SELECT id FROM pseudonym_mapping WHERE ${WHERE_COMBO} AND status = 'active' FOR UPDATE`, combo);
      await client.query(
        `UPDATE pseudonym_mapping SET status = 'expired' WHERE ${WHERE_COMBO} AND status = 'active' AND expires_at < $4`,
        [...combo, now]);
      const found = await client.query(
        `SELECT id, pseudonym FROM pseudonym_mapping WHERE ${WHERE_COMBO} AND status = 'active'`, combo);
      if (found.rowCount > 0) {
        await client.query('COMMIT');
        return { reused: true, pseudonym: found.rows[0].pseudonym, mappingId: found.rows[0].id, attempts: 0 };
      }
      const expiresAt = new Date(clock.now() + req.ttlSeconds * 1000).toISOString();
      const id = randomUUID();
      const enc = encryptField(keys.kField, keyVersion, req.subjectId, aadMapping(req.subjectType, id));
      for (let attempts = 1; attempts <= 20; attempts++) {
        const pseudonym = tokenFn(keys.kToken, req.subjectType, req.subjectId, req.serviceId, req.purpose, randomUUID(), attempts);
        const ins = await client.query(
          `INSERT INTO pseudonym_mapping
             (id, subject_type, subject_id_enc, subject_lookup, pseudonym, service_id, purpose, transaction_id, key_version, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (pseudonym) DO NOTHING RETURNING id`,
          [id, req.subjectType, enc, lookup, pseudonym, req.serviceId, req.purpose, req.transactionId ?? null, keyVersion, now, expiresAt]);
        if (ins.rowCount === 1) {
          await client.query('COMMIT');
          return { reused: false, pseudonym, mappingId: ins.rows[0].id, attempts };
        }
      }
      throw new Error('too many pseudonym collisions');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (strategy === 'B' && err.code === '23505' && err.constraint === 'uq_mapping_active') continue;
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('gave up after retries');
}
