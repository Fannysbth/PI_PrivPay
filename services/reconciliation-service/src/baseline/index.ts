import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { Pool } from 'pg';
import { ReconciliationRepository } from '../reconciliation/repository';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the baseline mode, which stores account numbers. Refused unless baseline. */
export function baselineReconciliationRepository(
  mode: PrivacyMode,
  pool: Pick<Pool, 'connect' | 'query'>,
): ReconciliationRepository {
  assertBaselineMode(mode);
  return new ReconciliationRepository(pool, SUBJECT_SQL);
}
