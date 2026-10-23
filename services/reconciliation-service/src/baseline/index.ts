import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { Pool } from 'pg';
import type { PrivacyClient, TransactionClient } from '../reconciliation';
import { ReconciliationRepository } from '../reconciliation/repository';
import { BaselinePrivacyClient } from './privacy-client';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the baseline mode, which stores account numbers. Refused unless baseline. */
export function baselineReconciliationRepository(
  mode: PrivacyMode,
  pool: Pick<Pool, 'connect' | 'query'>,
): ReconciliationRepository {
  assertBaselineMode(mode);
  return new ReconciliationRepository(pool, SUBJECT_SQL);
}

/** ADR-0006: the account of a transaction in the baseline mode comes from Transaction. Refused unless baseline. */
export function baselinePrivacyClient(
  mode: PrivacyMode,
  transactions: Pick<TransactionClient, 'byId'>,
): PrivacyClient {
  assertBaselineMode(mode);
  return new BaselinePrivacyClient(transactions);
}
