import type { Pool } from 'pg';
import { AssessmentRepository } from '../risk/repository';
import { SUBJECT_SQL } from './subject-sql';

/** ADR-0006: the repository of the proposed mode, which keys the history by token. */
export const proposedAssessmentRepository = (pool: Pick<Pool, 'query'>): AssessmentRepository =>
  new AssessmentRepository(pool, SUBJECT_SQL);
