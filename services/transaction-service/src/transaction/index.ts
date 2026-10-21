export {
  TransactionProcessor,
  type ProcessResult,
  type TransactionProcessorDeps,
  type TransactionRequest,
} from './processor';
export {
  privacyStatusOf,
  TokenExpiredError,
  type FraudClient,
  type FraudVerdict,
  type NotificationClient,
  type NotificationTemplate,
  type PrivacyStatusClient,
  type PrivacyTransactionStatus,
  type SubjectReferencePort,
  type SubjectRow,
} from './ports';
export { assertTransition, canTransition } from './status-machine';
export {
  TRANSACTION_SQL,
  TransactionRepository,
  type FraudDecision,
  type NewTransaction,
  type Outcome,
  type StoredTransaction,
  type TransactionStatus,
} from './repository';
