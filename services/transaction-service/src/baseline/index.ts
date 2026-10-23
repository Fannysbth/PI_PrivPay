import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { Pool } from 'pg';
import { TransactionRepository } from '../transaction/repository';
import { BaselineSubjectReferences } from './subject-references';
import { SUBJECT_SQL } from './subject-sql';

export { BaselineSubjectReferences };

/** ADR-0006: the repository of the baseline mode, which stores the identity. Refused unless the mode is baseline. */
export function baselineTransactionRepository(
  mode: PrivacyMode,
  pool: Pick<Pool, 'query' | 'connect'>,
): TransactionRepository {
  assertBaselineMode(mode);
  return new TransactionRepository(pool, SUBJECT_SQL);
}

/** ADR-0006: the port of the baseline mode, which hands the identity over as it is. Refused unless the mode is baseline. */
export function baselineSubjectReferences(mode: PrivacyMode): BaselineSubjectReferences {
  assertBaselineMode(mode);
  return new BaselineSubjectReferences();
}
