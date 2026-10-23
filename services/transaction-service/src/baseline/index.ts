import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { Pool } from 'pg';
import type { PrivacyStatusClient } from '../transaction/ports';
import { TransactionRepository } from '../transaction/repository';
import { BaselinePrivacyStatus } from './privacy-status';
import { BaselineSubjectReferences } from './subject-references';
import { SUBJECT_SQL } from './subject-sql';

export type { BaselineSubjectReferences };

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

/** ADR-0006: the status port of the baseline mode, which has no Privacy to tell. Refused unless baseline. */
export function baselinePrivacyStatus(mode: PrivacyMode): PrivacyStatusClient {
  assertBaselineMode(mode);
  return new BaselinePrivacyStatus();
}
