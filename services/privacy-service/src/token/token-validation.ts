import { DomainError } from '@privpay/common';
import { AUDIT_FORMATS } from '../audit';
import type {
  CommonRequest,
  ExchangeRequest,
  FromTransactionRequest,
  GenerateRequest,
  ReIssueRequest,
  ResolveDomainRequest,
} from './token-types';

// Formats of platform-dan-ci.md 3.1; the shape of a request is checked before anything is decided or audited.
export const CUSTOMER_ID = /^CUST-[0-9]{6}$/;
export const ACCOUNT_NUMBER = /^[0-9]{8,20}$/;
export const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');
const isText = (value: unknown): value is string => typeof value === 'string';

export function textMatching(value: unknown, pattern: RegExp): void {
  if (!isText(value) || !pattern.test(value)) throw invalid();
}

/** The text fields are checked as text first: the type says string, but the data comes from outside (CLAUDE.md). */
export function assertCommon(request: CommonRequest): void {
  textMatching(request.requestingService, SERVICE_ID);
  if (request.actorId !== undefined) textMatching(request.actorId, AUDIT_FORMATS.actorId);
}

function assertTarget(request: { targetService: string; purpose: string }): void {
  textMatching(request.targetService, SERVICE_ID);
  textMatching(request.purpose, AUDIT_FORMATS.purpose);
}

function assertSubjectType(subjectType: unknown): 'CUSTOMER' | 'ACCOUNT' {
  if (subjectType !== 'CUSTOMER' && subjectType !== 'ACCOUNT') throw invalid();
  return subjectType;
}

export function assertGenerate(request: GenerateRequest): void {
  assertCommon(request);
  assertTarget(request);
  const subjectType = assertSubjectType(request.subjectType);
  textMatching(request.subjectId, subjectType === 'CUSTOMER' ? CUSTOMER_ID : ACCOUNT_NUMBER);
  if (request.transactionId !== undefined) {
    textMatching(request.transactionId, AUDIT_FORMATS.transactionId);
  }
}

export function assertExchange(request: ExchangeRequest): void {
  assertCommon(request);
  assertTarget(request);
  textMatching(request.sourcePseudonym, AUDIT_FORMATS.pseudonym);
  textMatching(request.transactionId, AUDIT_FORMATS.transactionId);
}

export function assertReIssue(request: ReIssueRequest): void {
  assertCommon(request);
  textMatching(request.pseudonym, AUDIT_FORMATS.pseudonym);
  textMatching(request.transactionId, AUDIT_FORMATS.transactionId);
}

export function assertResolveDomain(request: ResolveDomainRequest): void {
  assertCommon(request);
  textMatching(request.notifToken, AUDIT_FORMATS.pseudonym);
}

export function assertFromTransaction(request: FromTransactionRequest): void {
  assertCommon(request);
  assertTarget(request);
  assertSubjectType(request.subjectType);
  textMatching(request.transactionId, AUDIT_FORMATS.transactionId);
  if (request.actorRole !== undefined && !isText(request.actorRole)) throw invalid();
}
