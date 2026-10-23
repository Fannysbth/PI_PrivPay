import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { Pool } from 'pg';
import { AssessmentRepository } from '../risk/repository';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the baseline mode, which keys the history by customer_id. Refused unless baseline. */
export function baselineAssessmentRepository(
  mode: PrivacyMode,
  pool: Pick<Pool, 'query'>,
): AssessmentRepository {
  assertBaselineMode(mode);
  return new AssessmentRepository(pool, SUBJECT_SQL);
}
