import type { Pool } from 'pg';
import { ReconciliationRepository } from '../reconciliation/repository';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the proposed mode, which stores account tokens. */
export const proposedReconciliationRepository = (
  pool: Pick<Pool, 'connect' | 'query'>,
): ReconciliationRepository => new ReconciliationRepository(pool, SUBJECT_SQL);
