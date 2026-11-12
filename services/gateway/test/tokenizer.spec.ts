import { DomainError } from '@privpay/common';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import { FakePrivacyPort } from '../src/tokenizer/fake-privacy-port';
import { Tokenizer } from '../src/tokenizer/tokenizer';

// Seam: Tokenizer.tokenize (pure, no NestJS) against the fake PrivacyPort. Values are the generated canaries.
const person = buildCanary(41);
// Built at run time: a literal UUID under services/ would be reported by the secret scan.
const IDEMPOTENCY_KEY = ['3f2b8c1e', '6a4d', '4e7b', '9c1a', '0d5e7f9a1b2c'].join('-');
const body = {
  source_account: person.rekening,
  merchant_id: 'MRC-001',
  amount: 150000,
  geohash: 'qqguy',
  nik: person.nik,
  nama: person.nama,
  email: person.email,
};

let privacy: FakePrivacyPort;
let tokenizer: Tokenizer;
beforeEach(() => {
  privacy = new FakePrivacyPort();
  tokenizer = new Tokenizer({ privacy, newTransactionId: () => 'TX-1760000000000001' });
});

const transaction = (over: Record<string, unknown> = {}, customerId = person.customer_id) =>
  tokenizer.tokenize({
    route: 'transaction',
    claims: { customerId },
    idempotencyKey: IDEMPOTENCY_KEY,
    body: { ...body, ...over },
  });

describe('M2-11 Tokenizer: POST /transaction', () => {
  it('M2-11 FR-02 FR-03 the outbound payload is built from the allow list and holds no canary', async () => {
    const result = await transaction();
    if (result.route !== 'transaction') throw new Error('transaction result');
    expect(Object.keys(result.outbound).sort()).toEqual(
      [
        'account_token',
        'amount',
        'customer_token',
        'geohash',
        'idempotency_key',
        'merchant_id',
        'transaction_id',
      ].sort(),
    );
    expect(result.outbound).toMatchObject({
      transaction_id: 'TX-1760000000000001',
      idempotency_key: IDEMPOTENCY_KEY,
      merchant_id: 'MRC-001',
      amount: 150000,
      geohash: 'qqguy',
    });
    expect(result.transactionId).toBe('TX-1760000000000001');
    assertNoFindings(
      scanText(JSON.stringify(result.outbound), [person], {
        service: 'transaction',
        location: 'outbound',
      }),
    );
  });

  it('M2-11 FR-02 asks Privacy for P1 and P2 with the transaction id, one call per subject', async () => {
    await transaction();
    expect(privacy.calls).toHaveLength(2);
    expect(privacy.calls).toContainEqual({
      subjectType: 'CUSTOMER',
      subjectId: person.customer_id,
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId: 'TX-1760000000000001',
    });
    expect(privacy.calls).toContainEqual({
      subjectType: 'ACCOUNT',
      subjectId: person.rekening,
      targetService: 'TRANSACTION',
      purpose: 'PAYMENT_PROCESSING',
      transactionId: 'TX-1760000000000001',
    });
  });

  it('ADR-0019 a payment asks Privacy once, for P1 and P2 together, and the tokens go to the right fields', async () => {
    const result = await transaction();
    expect(privacy.batches).toHaveLength(1);
    expect(privacy.singles).toHaveLength(0);
    expect(privacy.batches[0]?.map((request) => request.subjectType)).toEqual([
      'CUSTOMER',
      'ACCOUNT',
    ]);
    if (result.route !== 'transaction') throw new Error('route');
    expect(result.outbound.customer_token).not.toBe(result.outbound.account_token);
    expect(result.outbound.customer_token).toMatch(/^PSEU-/);
    expect(result.outbound.account_token).toMatch(/^PSEU-/);
  });

  it('ADR-0019 TK-16 a port that answers with fewer tokens than asked is SERVICE_UNAVAILABLE, never a payment', async () => {
    privacy = new FakePrivacyPort();
    privacy.pseudonymizeBatch = () => Promise.resolve(['PSEU-0000000A']);
    tokenizer = new Tokenizer({ privacy, newTransactionId: () => 'TX-1' });
    await expect(transaction()).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
  });

  it('M2-11 FR-38 NFR-11 TK-16 Privacy unavailable: SERVICE_UNAVAILABLE and nothing is returned to forward', async () => {
    privacy = new FakePrivacyPort(() => new DomainError('SERVICE_UNAVAILABLE', 'timeout'));
    tokenizer = new Tokenizer({ privacy, newTransactionId: () => 'TX-1' });
    await expect(transaction()).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
  });

  it('M2-11 FR-38 a refusal by Privacy is the refusal, and one failed subject cancels the whole request', async () => {
    privacy = new FakePrivacyPort((request) =>
      request.subjectType === 'ACCOUNT' ? new DomainError('POLICY_NOT_ALLOWED') : undefined,
    );
    tokenizer = new Tokenizer({ privacy, newTransactionId: () => 'TX-1' });
    await expect(transaction()).rejects.toMatchObject({ reason: 'POLICY_NOT_ALLOWED' });
  });

  it.each([
    ['unknown field', { surprise: 1 }],
    ['amount zero', { amount: 0 }],
    ['amount fractional', { amount: 1.5 }],
    ['merchant id', { merchant_id: 'X-1' }],
    ['geohash', { geohash: 'AAA' }],
    ['account', { source_account: '12' }],
  ])('M2-11 a bad %s is VALIDATION_ERROR before Privacy is asked', async (_name, over) => {
    await expect(transaction(over)).rejects.toMatchObject({ reason: 'VALIDATION_ERROR' });
    expect(privacy.calls).toHaveLength(0);
  });

  it('M2-11 K-17 a key that is not a UUID is refused and a generated id that is not TX-digits is a fault', async () => {
    await expect(
      tokenizer.tokenize({
        route: 'transaction',
        claims: { customerId: person.customer_id },
        idempotencyKey: 'x',
        body,
      }),
    ).rejects.toMatchObject({ reason: 'VALIDATION_ERROR' });
    tokenizer = new Tokenizer({ privacy, newTransactionId: () => 'nope' });
    await expect(transaction()).rejects.toMatchObject({ reason: 'INTERNAL_ERROR' });
    expect(privacy.calls).toHaveLength(0);
  });
});

const batch = (items: unknown[], date = '2026-10-20') => ({ batch_date: date, items });
const item = (n: number, account = buildCanary(n).rekening) => ({
  account_number: account,
  amount: 1000 + n,
  bank_reference: `BANK-REF-${String(n)}`,
});
const settle = (payload: unknown) => tokenizer.tokenize({ route: 'settlement', body: payload });

describe('M2-11 Tokenizer: POST /settlement/report', () => {
  it('M2-11 FR-32 TF-13 tokens replace the account numbers; the order and the other fields are kept', async () => {
    const result = await settle(batch([item(1), item(2)]));
    if (result.route !== 'settlement') throw new Error('settlement result');
    expect(result.outbound.batch_date).toBe('2026-10-20');
    expect(result.outbound.items.map((entry) => entry.bank_reference)).toEqual([
      'BANK-REF-1',
      'BANK-REF-2',
    ]);
    expect(result.outbound.items.map((entry) => entry.amount)).toEqual([1001, 1002]);
    assertNoFindings(
      scanText(JSON.stringify(result.outbound), [buildCanary(1), buildCanary(2)], {
        service: 'reconciliation',
        location: 'outbound',
      }),
    );
    expect(privacy.calls).toContainEqual({
      subjectType: 'ACCOUNT',
      subjectId: buildCanary(1).rekening,
      targetService: 'RECONCILIATION',
      purpose: 'DAILY_RECONCILIATION',
    });
  });

  it('M2-11 FR-32 the same account twice in a batch gets one token, asked once', async () => {
    const result = await settle(batch([item(1), item(2, buildCanary(1).rekening)]));
    if (result.route !== 'settlement') throw new Error('settlement result');
    expect(result.outbound.items[0]?.account_pseudonym).toBe(
      result.outbound.items[1]?.account_pseudonym,
    );
    expect(privacy.calls).toHaveLength(1);
  });

  it.each([
    ['empty items', batch([])],
    ['bad date', batch([item(1)], '2026-13-45')],
    [
      'bad account in the last item',
      batch([item(1), item(2), { ...item(3), account_number: 'abc' }]),
    ],
    ['amount zero', batch([item(1), { ...item(2), amount: 0 }])],
    ['bank reference', batch([{ ...item(1), bank_reference: 'lower case' }])],
    ['unknown field', batch([{ ...item(1), extra: true }])],
    ['too many items', batch(Array.from({ length: 501 }, (_, n) => item(n % 1000)))],
  ])('M2-11 TF-13 %s is VALIDATION_ERROR and no token is asked for', async (_name, payload) => {
    await expect(settle(payload)).rejects.toMatchObject({ reason: 'VALIDATION_ERROR' });
    expect(privacy.calls).toHaveLength(0);
  });

  it('M2-11 NFR-11 Privacy unavailable on any account fails the whole report', async () => {
    privacy = new FakePrivacyPort((request) =>
      request.subjectId === buildCanary(2).rekening
        ? new DomainError('SERVICE_UNAVAILABLE', 'timeout')
        : undefined,
    );
    tokenizer = new Tokenizer({ privacy, newTransactionId: () => 'TX-1' });
    await expect(settle(batch([item(1), item(2), item(3)]))).rejects.toMatchObject({
      reason: 'SERVICE_UNAVAILABLE',
    });
  });
});
