import {
  ACCOUNT_NUMBER,
  DomainError,
  REASONS,
  isReason,
  type HttpClient,
  type TokenCache,
} from '@privpay/common';
import { z } from 'zod';
import { disclosedAttributes } from './attributes';
import type {
  Actor,
  ClientHolder,
  CompletedTransaction,
  DisclosedAttributes,
  PrivacyClient,
  TransactionClient,
  TransactionDetail,
} from './ports';

const PSEUDONYM = /^PSEU-[0-9A-F]{8}$/;
const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;
const pseudonymAnswer = z.object({ pseudonym: z.string().regex(PSEUDONYM) });
const errorAnswer = z.object({ error: z.object({ reason: z.string() }) });
const detailAnswer = z.object({
  transaction_id: z.string().regex(TRANSACTION_ID),
  amount: z.number().int().min(1),
  status: z.enum(['PENDING', 'COMPLETED', 'HELD', 'FAILED']),
  // Only baseline names it (N-46): the account number, in the form of that mode.
  account_number: z.string().regex(ACCOUNT_NUMBER).optional(),
});
const openAnswer = z.object({ attributes: disclosedAttributes });
// G5: in baseline the item also names the holder (Tabel IV); every holder field is optional because an old row has no NIK or
// name. The schema is not strict, and the holder is only kept when the bootstrap of the mode says so (`acceptClientIdentity`).
const completedItem = z.object({
  transaction_id: z.string().regex(TRANSACTION_ID),
  amount: z.number().int().min(1),
  completed_at: z.string().min(1),
  customer_id: z.string().max(16).optional(),
  account_number: z.string().regex(ACCOUNT_NUMBER).optional(),
  // Transaction stores what the client sent, an empty string included: it is read as absent, never as a failure of the day.
  nik: z.string().max(64).optional(),
  nama: z.string().max(200).optional(),
});
const completedPage = z.object({
  items: z.array(completedItem),
  next_cursor: z.string().nullable(),
});

export interface ClientDeps {
  readonly http: HttpClient;
  /** Reconciliation's own service token for the service it calls (`aud` privacy-service or transaction-service). */
  readonly serviceToken: Pick<TokenCache, 'get'>;
  /** G5: set by the bootstrap of the baseline mode only; the completed list then names the holder of each item. */
  readonly acceptClientIdentity?: boolean;
}

const unavailable = (cause: string): DomainError => new DomainError('SERVICE_UNAVAILABLE', cause);

/** A page is at most this many rows (the Gateway's own limit); a day is read page by page, never in one answer. */
const PAGE_SIZE = 200;
/** A bound on a loop that follows a cursor from another process: a cursor that never ends is a failure, not a hang. */
const MAX_PAGES = 1_000;

/** The holder an item names, or none when it names nothing of the four (an old row). */
function holderOf(item: z.infer<typeof completedItem>): ClientHolder | undefined {
  const holder: ClientHolder = {
    ...(!item.customer_id ? {} : { customerId: item.customer_id }),
    ...(!item.nik ? {} : { nik: item.nik }),
    ...(!item.nama ? {} : { nama: item.nama }),
    ...(!item.account_number ? {} : { accountNumber: item.account_number }),
  };
  return Object.keys(holder).length === 0 ? undefined : holder;
}

/** D1 (spec transaction 3.4). Every read is idempotent, so the shared client may retry it (NFR-12). */
export class HttpTransactionClient implements TransactionClient {
  constructor(private readonly deps: ClientDeps) {}

  async completedOn(date: string): Promise<readonly CompletedTransaction[]> {
    const all: CompletedTransaction[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query =
        `date=${encodeURIComponent(date)}&limit=${String(PAGE_SIZE)}` +
        (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const response = await this.deps.http.request({
        service: 'transaction-service',
        method: 'GET',
        path: `/transaction/completed?${query}`,
        idempotent: true,
        authorization: `Bearer ${await this.deps.serviceToken.get()}`,
      });
      const withHolder = this.deps.acceptClientIdentity === true;
      const parsed = completedPage.safeParse(response.body);
      if (response.status !== 200 || !parsed.success) throw unavailable('transaction_answer');
      for (const item of parsed.data.items) {
        const holder = withHolder ? holderOf(item) : undefined;
        all.push({
          transactionId: item.transaction_id,
          amount: item.amount,
          completedAt: item.completed_at,
          ...(holder === undefined ? {} : { holder }),
        });
      }
      cursor = parsed.data.next_cursor;
      if (cursor === null) return all;
    }
    throw unavailable('transaction_pages');
  }

  /** E1 (spec transaction 3.4): one transaction for an audit; a missing one keeps its own reason (K-02). */
  async byId(transactionId: string): Promise<TransactionDetail> {
    const response = await this.deps.http.request({
      service: 'transaction-service',
      method: 'GET',
      path: `/transaction/${encodeURIComponent(transactionId)}`,
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    if (response.status === 404 && reasonOf(response.body) === 'TRANSACTION_NOT_FOUND') {
      throw new DomainError('TRANSACTION_NOT_FOUND');
    }
    const parsed = detailAnswer.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) throw unavailable('transaction_answer');
    return {
      transactionId: parsed.data.transaction_id,
      amount: parsed.data.amount,
      status: parsed.data.status,
      ...(parsed.data.account_number === undefined
        ? {}
        : { accountRef: parsed.data.account_number }),
    };
  }
}

function reasonOf(body: unknown): string | undefined {
  const parsed = errorAnswer.safeParse(body);
  return parsed.success ? parsed.data.error.reason : undefined;
}

/**
 * A refusal of Privacy is passed on with its own reason, so the caller (and the audit) sees why. Only a refusal of the
 * kind a caller can cause is: a 401, a 429, a bad request of ours or anything unreadable is Privacy being away for this
 * purpose, and says nothing of the person (NFR-10).
 */
function refusalOf(response: { readonly status: number; readonly body: unknown }): DomainError {
  const reason = reasonOf(response.body);
  if (
    response.status >= 400 &&
    response.status < 500 &&
    reason !== undefined &&
    isReason(reason) &&
    REASONS[reason].code === 'ACCESS_DENIED'
  ) {
    return new DomainError(reason);
  }
  return unavailable('privacy_answer');
}

/** The calls to Privacy. `POST /pseudonymize` is idempotent, so the shared client may retry it (NFR-12). */
export class HttpPrivacyClient implements PrivacyClient {
  constructor(private readonly deps: ClientDeps) {}

  async accountSubjectRef(transactionId: string): Promise<string | null> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/pseudonymize',
      // Form 3 of spec privacy 4.1: Privacy derives the account from the mapping row of the transaction.
      body: {
        subject_type: 'ACCOUNT',
        transaction_id: transactionId,
        target_service: 'RECONCILIATION',
        purpose: 'DAILY_RECONCILIATION',
      },
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
    });
    const parsed = pseudonymAnswer.safeParse(response.body);
    if (response.status === 200 && parsed.success) return parsed.data.pseudonym;
    // Privacy has no account for this transaction any more (retention) or it was revoked: that transaction is
    // unmatched, and the batch goes on (spec reconciliation 3.2 step 2). Anything else is Privacy being away.
    const reason = reasonOf(response.body);
    if (
      (response.status === 404 && reason === 'TOKEN_NOT_FOUND') ||
      (response.status === 403 && reason === 'REVOKED')
    ) {
      return null;
    }
    throw unavailable('privacy_answer');
  }

  /** E2: form 3 for a CUSTOMER with the actor token, which P7 requires (spec privacy 4.1). Idempotent: the token is reused. */
  async auditToken(transactionId: string, actor: Actor): Promise<string> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/pseudonymize',
      body: {
        subject_type: 'CUSTOMER',
        transaction_id: transactionId,
        target_service: 'RECONCILIATION',
        purpose: 'INTERNAL_AUDIT',
      },
      idempotent: true,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
      actorToken: actor.token,
    });
    const parsed = pseudonymAnswer.safeParse(response.body);
    if (response.status === 200 && parsed.success) return parsed.data.pseudonym;
    throw refusalOf(response);
  }

  /** E3: the one point where an identity leaves Privacy. Not idempotent: one attempt, whatever happens (NFR-12). */
  async open(
    request: { auditToken: string; disclosureId: string },
    actor: Actor,
  ): Promise<DisclosedAttributes> {
    const response = await this.deps.http.request({
      service: 'privacy-service',
      method: 'POST',
      path: '/de-pseudonymize',
      // The purpose is this service's, not the caller's: it is the only one a P7 token has.
      body: {
        pseudonym: request.auditToken,
        purpose: 'INTERNAL_AUDIT',
        disclosure_id: request.disclosureId,
      },
      idempotent: false,
      authorization: `Bearer ${await this.deps.serviceToken.get()}`,
      actorToken: actor.token,
    });
    const parsed = openAnswer.safeParse(response.body);
    if (response.status === 200 && parsed.success) return parsed.data.attributes;
    if (response.status === 200) throw unavailable('privacy_answer');
    throw refusalOf(response);
  }
}
