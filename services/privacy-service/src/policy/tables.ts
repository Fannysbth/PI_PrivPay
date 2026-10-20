// PRD 6.1 Tabel 1, 2, 3, 5, 6 as typed constants (spec privacy 6). Changing a row needs an ADR; the spec locks them
// against the PRD. They are arrays searched with ===, not objects indexed by caller input, so a name such as
// `__proto__` or `constructor` can never reach a property of Object.prototype.
import type { AuditAttributeName } from '../audit';

export const PURPOSES = [
  'PAYMENT_PROCESSING',
  'FRAUD_DETECTION',
  'NOTIFICATION',
  'NOTIFICATION_REGISTRATION',
  'DAILY_RECONCILIATION',
  'INTERNAL_AUDIT',
] as const;
export type PolicyPurpose = (typeof PURPOSES)[number];

export type ContextId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';
export type RequiredRole = 'service' | 'auditor';

export interface ContextRow {
  readonly id: ContextId;
  readonly serviceId: string;
  readonly purpose: PolicyPurpose;
  readonly subjectType: 'CUSTOMER' | 'ACCOUNT';
  /** "Boleh dibuka": only P7 (Tabel 1, Tabel 5). */
  readonly mayDisclose: boolean;
  readonly requiredRole: RequiredRole;
}

/** Tabel 1. TTLs are not here: they are configuration (CLAUDE.md), injected per purpose. */
export const TABLE_1: readonly ContextRow[] = [
  {
    id: 'P1',
    serviceId: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    subjectType: 'CUSTOMER',
    mayDisclose: false,
    requiredRole: 'service',
  },
  {
    id: 'P2',
    serviceId: 'TRANSACTION',
    purpose: 'PAYMENT_PROCESSING',
    subjectType: 'ACCOUNT',
    mayDisclose: false,
    requiredRole: 'service',
  },
  {
    id: 'P3',
    serviceId: 'FRAUD',
    purpose: 'FRAUD_DETECTION',
    subjectType: 'CUSTOMER',
    mayDisclose: false,
    requiredRole: 'service',
  },
  {
    id: 'P4',
    serviceId: 'NOTIFICATION',
    purpose: 'NOTIFICATION',
    subjectType: 'CUSTOMER',
    mayDisclose: false,
    requiredRole: 'service',
  },
  {
    id: 'P5',
    serviceId: 'NOTIFICATION',
    purpose: 'NOTIFICATION_REGISTRATION',
    subjectType: 'CUSTOMER',
    mayDisclose: false,
    requiredRole: 'service',
  },
  {
    id: 'P6',
    serviceId: 'RECONCILIATION',
    purpose: 'DAILY_RECONCILIATION',
    subjectType: 'ACCOUNT',
    mayDisclose: false,
    requiredRole: 'service',
  },
  {
    id: 'P7',
    serviceId: 'RECONCILIATION',
    purpose: 'INTERNAL_AUDIT',
    subjectType: 'CUSTOMER',
    mayDisclose: true,
    requiredRole: 'auditor',
  },
];

export type ContextOperation =
  'GENERATE_FROM_IDENTITY' | 'GENERATE_FROM_TRANSACTION' | 'DE_PSEUDONYMIZE' | 'RE_ISSUE';
export type Operation = ContextOperation | 'EXCHANGE' | 'RESOLVE_NOTIF_DOMAIN' | 'UPDATE_TX_STATUS';

/**
 * Tabel 3: who may call and which contexts the operation may touch. RESOLVE_NOTIF_DOMAIN and EXCHANGE decide their
 * contexts later (from the token, from Tabel 2), so they list no contexts here.
 */
export const TABLE_3: readonly {
  readonly operation: Operation;
  readonly caller: string;
  readonly contexts: readonly ContextId[];
}[] = [
  {
    operation: 'GENERATE_FROM_IDENTITY',
    caller: 'API_GATEWAY',
    contexts: ['P1', 'P2', 'P5', 'P6'],
  },
  { operation: 'GENERATE_FROM_TRANSACTION', caller: 'RECONCILIATION', contexts: ['P6', 'P7'] },
  { operation: 'EXCHANGE', caller: 'TRANSACTION', contexts: [] },
  { operation: 'RESOLVE_NOTIF_DOMAIN', caller: 'NOTIFICATION', contexts: [] },
  // Tabel 3: not a token operation, so it touches no context and is not audited.
  { operation: 'UPDATE_TX_STATUS', caller: 'TRANSACTION', contexts: [] },
  { operation: 'DE_PSEUDONYMIZE', caller: 'RECONCILIATION', contexts: ['P7'] },
  { operation: 'RE_ISSUE', caller: 'TRANSACTION', contexts: ['P1', 'P2'] },
];

/** Tabel 2: the only two exchanges in the whole system. */
export const TABLE_2: readonly {
  readonly source: ContextId;
  readonly target: ContextId;
  readonly caller: string;
}[] = [
  { source: 'P1', target: 'P3', caller: 'TRANSACTION' },
  { source: 'P1', target: 'P4', caller: 'TRANSACTION' },
];

/** Tabel 5: what a disclosure may return, for the contexts that may be opened. HP and account number never. */
export const DISCLOSABLE_ATTRIBUTES: readonly AuditAttributeName[] = Object.freeze([
  'customer_id',
  'nik',
  'nama',
]);

/** Tabel 6: the legitimate bases for a disclosure request (PRD 7.4 flow E2, TK-27). */
export const DISCLOSURE_BASES: readonly string[] = Object.freeze([
  'DISPUTE',
  'FRAUD_CONFIRMED',
  'LEGAL_REQUEST',
]);
