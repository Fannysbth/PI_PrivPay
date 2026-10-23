import { assertBaselineMode, type PrivacyMode } from '@privpay/common';
import type { Pool } from 'pg';
import { ContactRepository } from '../notification/contacts';
import type { PrivacyClient } from '../notification/service';
import { BaselinePrivacyClient } from './privacy-client';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the baseline mode, which keys the contact by customer_id. Refused unless baseline. */
export function baselineContactRepository(
  mode: PrivacyMode,
  pool: Pick<Pool, 'query'>,
): ContactRepository {
  assertBaselineMode(mode);
  return new ContactRepository(pool, SUBJECT_SQL);
}

/** ADR-0006: the "resolution" of the baseline mode, which hands the customer id back. Refused unless baseline. */
export function baselinePrivacyClient(mode: PrivacyMode): PrivacyClient {
  assertBaselineMode(mode);
  return new BaselinePrivacyClient();
}
