import type { Pool } from 'pg';
import { TransactionRepository } from '../transaction/repository';
import { SUBJECT_SQL } from './subject-sql';

export { ProposedSubjectReferences } from './subject-references';

/** ADR-0006: the repository of the proposed mode, which stores tokens only. */
export const proposedTransactionRepository = (
  pool: Pick<Pool, 'query' | 'connect'>,
): TransactionRepository => new TransactionRepository(pool, SUBJECT_SQL);
