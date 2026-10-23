import type { Pool } from 'pg';
import { ContactRepository } from '../notification/contacts';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the proposed mode, which keys the contact by domain token. */
export const proposedContactRepository = (pool: Pick<Pool, 'query'>): ContactRepository =>
  new ContactRepository(pool, SUBJECT_SQL);
