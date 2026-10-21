import type { HumanRole } from '@privpay/common';
import { z } from 'zod';
import { settlementBody, transactionBody } from './tokenizer/schemas';

export type Upstream = 'privacy-service' | 'transaction-service' | 'reconciliation-service';

/**
 * How the call goes on (gateway spec 3):
 * - `gateway-token+actor`: `Authorization` is the gateway's own service token, `X-Actor-Token` is the person's token;
 * - `human-token`: the person's token is passed on as `Authorization` (ADR-0007 item 2);
 * - `gateway-token`: the gateway's own service token alone, for the calls of customers and of the bank, whose token
 *   (a customer's carries `customer_id`) is never passed on.
 * A customer's token is never passed on, whatever the route.
 */
export type DownstreamAuth = 'gateway-token+actor' | 'human-token' | 'gateway-token';

/** Who may call a route: the people of the admin console (by role), a customer, or the bank. */
export type CallerKind = 'person' | 'customer' | 'bank';

export interface Route {
  /** The AZ id of docs/spec/endpoints.md. */
  readonly id: string;
  readonly method: 'GET' | 'POST';
  /** Segments separated by `/`; `{name}` is a path parameter checked by `params[name]`. */
  readonly pattern: string;
  readonly params: Readonly<Record<string, RegExp>>;
  /** Who may call: people of the admin console, by role. The service re-checks (defence in depth). */
  readonly who: readonly HumanRole[];
  /** A customer or bank route lists no role. */
  readonly caller: CallerKind;
  /** Set on the routes whose identifiers are replaced by tokens before the call goes on (gateway spec 4, 5). */
  readonly tokenize: 'transaction' | 'settlement' | null;
  readonly upstream: Upstream;
  /** Path on the upstream, with the same `{name}` placeholders. */
  readonly upstreamPath: string;
  readonly auth: DownstreamAuth;
  /** Strict schema of the JSON body, or null when the route takes none. */
  readonly body: z.ZodType | null;
  /** Strict schema of the query string, or null when the route takes none. */
  readonly query: z.ZodType | null;
  /** Largest accepted body in bytes (gateway spec 3: 16 KiB, 64 KiB for settlement). */
  readonly maxBodyBytes: number;
}

// Shared shapes (platform spec 3).
const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;
const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CASE_REF = /^[A-Z0-9-]{1,64}$/;
const SUBJECT_CUSTOMER = /^CUST-[0-9]{6}$/;
const SUBJECT_ACCOUNT = /^[0-9]{8,20}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
const CURSOR = /^[A-Za-z0-9_=.-]{1,256}$/;
const FILTER = /^[A-Za-z0-9_.:-]{1,64}$/;

const SIXTEEN_KIB = 16 * 1024;

const isRealDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const limit = z
  .string()
  .regex(/^[0-9]{1,3}$/)
  .refine((value) => Number(value) >= 1 && Number(value) <= 200);
const page = { limit: limit.optional(), cursor: z.string().regex(CURSOR).optional() };

const noBody = z.strictObject({});
const body = {
  review: z.strictObject({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason_code: z.enum(['CONFIRMED_BY_CUSTOMER', 'SUSPECTED_FRAUD', 'OTHER']),
  }),
  auditRequest: z.strictObject({
    transaction_id: z.string().regex(TRANSACTION_ID),
    reason_code: z.enum(['AMOUNT_MISMATCH', 'DISPUTE', 'OTHER']),
  }),
  disclosure: z.strictObject({
    audit_token: z.string().regex(PSEUDONYM),
    disclosure_id: z.string().regex(UUID),
  }),
  run: z.strictObject({ date: z.string().regex(ISO_DATE).refine(isRealDate) }),
  disclosureRequest: z.strictObject({
    audit_token: z.string().regex(PSEUDONYM),
    basis: z.enum(['DISPUTE', 'FRAUD_CONFIRMED', 'LEGAL_REQUEST']),
    case_ref: z.string().regex(CASE_REF),
    attributes: z
      .array(z.enum(['customer_id', 'nik', 'nama']))
      .min(1)
      .max(3)
      .refine((list) => new Set(list).size === list.length),
  }),
  subjectRevoke: z.discriminatedUnion('subject_type', [
    z.strictObject({
      subject_type: z.literal('CUSTOMER'),
      subject_id: z.string().regex(SUBJECT_CUSTOMER),
    }),
    z.strictObject({
      subject_type: z.literal('ACCOUNT'),
      subject_id: z.string().regex(SUBJECT_ACCOUNT),
    }),
  ]),
};

const query = {
  held: z.strictObject(page),
  auditLog: z.strictObject({
    ...page,
    service: z.string().regex(FILTER).optional(),
    status: z.string().regex(FILTER).optional(),
    reason: z.string().regex(FILTER).optional(),
    pseudonym: z.string().regex(PSEUDONYM).optional(),
    transaction_id: z.string().regex(TRANSACTION_ID).optional(),
    from: z.string().regex(ISO_INSTANT).optional(),
    to: z.string().regex(ISO_INSTANT).optional(),
    action: z.string().regex(FILTER).optional(),
    disclosure_id: z.string().regex(UUID).optional(),
  }),
  timeline: z.strictObject(page),
  summary: z.strictObject({
    from: z.string().regex(ISO_INSTANT).optional(),
    to: z.string().regex(ISO_INSTANT).optional(),
  }),
};

const forward = (
  route: Pick<Route, 'id' | 'method' | 'pattern' | 'who' | 'upstream' | 'auth'> &
    Partial<
      Pick<
        Route,
        'params' | 'body' | 'query' | 'upstreamPath' | 'caller' | 'tokenize' | 'maxBodyBytes'
      >
    >,
): Route => ({
  params: {},
  body: null,
  query: null,
  upstreamPath: route.pattern,
  caller: 'person',
  tokenize: null,
  maxBodyBytes: SIXTEEN_KIB,
  ...route,
});

/**
 * The operations of people of the admin console (docs/spec/endpoints.md AZ-04..AZ-08, AZ-10..AZ-17). The routes that
 * tokenize identity are in TOKENIZING_ROUTES; the registration and notification ones are added by the tickets that
 * build them, so until then they do not exist and nothing raw can be forwarded.
 */
export const ROUTES: readonly Route[] = [
  forward({
    id: 'AZ-04',
    method: 'GET',
    pattern: '/transaction/held',
    who: ['fraud_analyst'],
    upstream: 'transaction-service',
    auth: 'gateway-token+actor',
    query: query.held,
  }),
  forward({
    id: 'AZ-05',
    method: 'POST',
    pattern: '/transaction/{id}/review',
    params: { id: TRANSACTION_ID },
    who: ['fraud_analyst'],
    upstream: 'transaction-service',
    auth: 'gateway-token+actor',
    body: body.review,
  }),
  forward({
    id: 'AZ-06',
    method: 'POST',
    pattern: '/reconciliation/audit-request',
    who: ['auditor'],
    upstream: 'reconciliation-service',
    auth: 'gateway-token+actor',
    body: body.auditRequest,
  }),
  forward({
    id: 'AZ-07',
    method: 'POST',
    pattern: '/reconciliation/disclosure',
    who: ['auditor'],
    upstream: 'reconciliation-service',
    auth: 'gateway-token+actor',
    body: body.disclosure,
  }),
  forward({
    id: 'AZ-08',
    method: 'POST',
    pattern: '/reconciliation/run',
    who: ['admin'],
    upstream: 'reconciliation-service',
    auth: 'gateway-token+actor',
    body: body.run,
  }),
  forward({
    id: 'AZ-10',
    method: 'POST',
    pattern: '/disclosure-requests',
    who: ['auditor'],
    upstream: 'privacy-service',
    auth: 'human-token',
    body: body.disclosureRequest,
  }),
  forward({
    id: 'AZ-11',
    method: 'POST',
    pattern: '/disclosure-requests/{id}/approve',
    params: { id: UUID },
    who: ['admin'],
    upstream: 'privacy-service',
    auth: 'human-token',
    body: noBody,
  }),
  forward({
    id: 'AZ-12',
    method: 'POST',
    pattern: '/disclosure-requests/{id}/reject',
    params: { id: UUID },
    who: ['admin'],
    upstream: 'privacy-service',
    auth: 'human-token',
    body: noBody,
  }),
  forward({
    id: 'AZ-13',
    method: 'GET',
    pattern: '/audit-log',
    who: ['auditor', 'admin'],
    upstream: 'privacy-service',
    auth: 'human-token',
    query: query.auditLog,
  }),
  forward({
    id: 'AZ-14',
    method: 'GET',
    pattern: '/audit-log/timeline/{pseudonym}',
    params: { pseudonym: PSEUDONYM },
    who: ['auditor'],
    upstream: 'privacy-service',
    auth: 'human-token',
    query: query.timeline,
  }),
  forward({
    id: 'AZ-15',
    method: 'GET',
    pattern: '/audit-log/summary',
    who: ['auditor'],
    upstream: 'privacy-service',
    auth: 'human-token',
    query: query.summary,
  }),
  forward({
    id: 'AZ-16',
    method: 'POST',
    pattern: '/pseudonym/{pseudonym}/revoke',
    params: { pseudonym: PSEUDONYM },
    who: ['admin'],
    upstream: 'privacy-service',
    auth: 'human-token',
    body: noBody,
  }),
  forward({
    id: 'AZ-17',
    method: 'POST',
    pattern: '/subject/revoke',
    who: ['admin'],
    upstream: 'privacy-service',
    auth: 'human-token',
    body: body.subjectRevoke,
  }),
];

/**
 * The routes that replace raw identifiers by tokens (gateway spec 3 to 5). They are served only with a tokenizer
 * behind them, which fails closed. The upstream path is where the tokenized payload goes, not the client's path.
 */
export const TOKENIZING_ROUTES: readonly Route[] = [
  forward({
    id: 'AZ-03',
    method: 'POST',
    pattern: '/transaction',
    who: [],
    caller: 'customer',
    tokenize: 'transaction',
    upstream: 'transaction-service',
    auth: 'gateway-token',
    body: transactionBody,
  }),
  forward({
    id: 'AZ-09',
    method: 'POST',
    pattern: '/settlement/report',
    who: [],
    caller: 'bank',
    tokenize: 'settlement',
    upstream: 'reconciliation-service',
    upstreamPath: '/reconciliation/settlement-report',
    auth: 'gateway-token',
    body: settlementBody,
    // Gateway spec 3: 64 KiB for settlement.
    maxBodyBytes: 64 * 1024,
  }),
];

/** Every route the gateway serves. `ROUTES` alone is the part for people of the admin console. */
export const ALL_ROUTES: readonly Route[] = [...ROUTES, ...TOKENIZING_ROUTES];

export interface RouteMatch {
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
}

/** The one list of routes (gateway spec 2). A path or method not in it does not exist. */
export class RouteTable {
  constructor(private readonly routes: readonly Route[] = ALL_ROUTES) {}

  /** `path` is the path alone, without a query string. */
  match(method: string, path: string): RouteMatch | undefined {
    const segments = path.split('/');
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = this.matchSegments(route, segments);
      if (params !== undefined) return { route, params };
    }
    return undefined;
  }

  private matchSegments(route: Route, actual: string[]): Record<string, string> | undefined {
    const expected = route.pattern.split('/');
    if (expected.length !== actual.length) return undefined;
    const params: Record<string, string> = {};
    for (const [index, part] of expected.entries()) {
      const value = actual[index] ?? '';
      const name = /^\{([a-z]+)\}$/.exec(part)?.[1];
      if (name === undefined) {
        if (part !== value) return undefined;
      } else {
        const shape = Object.hasOwn(route.params, name) ? route.params[name] : undefined;
        if (shape === undefined || !shape.test(value)) return undefined;
        params[name] = value;
      }
    }
    return params;
  }
}
