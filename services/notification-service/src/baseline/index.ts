import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { Pool } from 'pg';
import { ContactRepository } from '../notification/contacts';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the baseline mode, which keys the contact by customer_id. Refused unless baseline. */
export function baselineContactRepository(
  mode: PrivacyMode,
  pool: Pick<Pool, 'query'>,
): ContactRepository {
  assertBaselineMode(mode);
  return new ContactRepository(pool, SUBJECT_SQL);
}
