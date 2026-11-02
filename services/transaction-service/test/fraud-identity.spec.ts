import { createHttpClient, FakeDelay } from '@privpay/common';
import { baselineSubjectReferences } from '../src/baseline';
import { ProposedSubjectReferences } from '../src/proposed';
import { HttpFraudClient, HttpPrivacyClient } from '../src/transaction/clients';
import type { SubjectRow } from '../src/transaction';
import { buildCanary } from '../../../tests/pii-scan/canary';

// Seam: what Transaction hands to Fraud besides the customer reference (G3, Tabel IV baseline Fraud 4/6): the port
// decides per mode, the HTTP adapter puts it on the wire only when present. Values are canaries built at run time.
const person = buildCanary(100 + Math.floor(Math.random() * 90_000));
const row: SubjectRow = {
  transactionId: 'TX-6001',
  customerSubjectRef: person.customer_id,
  accountSubjectRef: person.rekening,
  clientIdentity: { nik: person.nik, nama: person.nama },
};

describe('G3 the baseline port names what Fraud receives besides the customer id', () => {
  it('G3 baseline hands over NIK, name and account number, and nothing else', async () => {
    const identity = await baselineSubjectReferences('baseline').identityForFraud(row);
    expect(identity).toEqual({
      nik: person.nik,
      nama: person.nama,
      accountNumber: person.rekening,
    });
  });

  it('G3 baseline leaves out what the client did not send, but keeps the account number', async () => {
    const bare: SubjectRow = {
      transactionId: row.transactionId,
      customerSubjectRef: row.customerSubjectRef,
      accountSubjectRef: row.accountSubjectRef,
    };
    expect(await baselineSubjectReferences('baseline').identityForFraud(bare)).toEqual({
      accountNumber: person.rekening,
    });
    const onlyName = { ...bare, clientIdentity: { nama: person.nama } };
    expect(await baselineSubjectReferences('baseline').identityForFraud(onlyName)).toEqual({
      nama: person.nama,
      accountNumber: person.rekening,
    });
  });

  it('G3 proposed hands over nothing, whatever the row holds', async () => {
    const http = createHttpClient({ baseUrls: {}, timeoutMs: 3000, maxRetries: 0 });
    const privacy = new HttpPrivacyClient({
      http,
      serviceToken: { get: () => Promise.resolve('x') },
    });
    expect(await new ProposedSubjectReferences(privacy).identityForFraud(row)).toBeUndefined();
  });
});

describe('G3 POST /fraud/assess carries the identity only when there is one', () => {
  const sendWith = async (identity?: {
    nik?: string;
    nama?: string;
    accountNumber?: string;
  }): Promise<Record<string, unknown>> => {
    let sent: Record<string, unknown> = {};
    const fetchStub: typeof fetch = (_input, init) => {
      sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      return Promise.resolve(
        new Response(JSON.stringify({ risk_score: 10, decision: 'ALLOW' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const http = createHttpClient({
      baseUrls: { 'fraud-service': 'http://fraud.test' },
      timeoutMs: 3000,
      maxRetries: 2,
      delay: new FakeDelay(),
      fetch: fetchStub,
    });
    await new HttpFraudClient({ http, serviceToken: { get: () => Promise.resolve('t') } }).assess({
      subject: person.customer_id,
      amount: 2_000_000,
      txHour: 9,
      geohash: 'qqgu4',
      ...(identity === undefined ? {} : { identity }),
    });
    return sent;
  };

  it('G3 the body has the customer reference, nik, nama and account_number, and no phone or email', async () => {
    const sent = await sendWith({
      nik: person.nik,
      nama: person.nama,
      accountNumber: person.rekening,
    });
    expect(Object.keys(sent).sort()).toEqual(
      ['account_number', 'amount', 'geohash', 'nama', 'nik', 'pseudonym', 'tx_hour'].sort(),
    );
    expect(sent).toMatchObject({
      pseudonym: person.customer_id,
      nik: person.nik,
      nama: person.nama,
      account_number: person.rekening,
    });
  });

  it('G3 without an identity the body is the four fields of proposed', async () => {
    expect(Object.keys(await sendWith()).sort()).toEqual(
      ['amount', 'geohash', 'pseudonym', 'tx_hour'].sort(),
    );
  });

  it('G3 a field that is absent is not sent as null', async () => {
    const sent = await sendWith({ accountNumber: person.rekening });
    expect(Object.keys(sent)).not.toContain('nik');
    expect(Object.keys(sent)).not.toContain('nama');
    expect(sent['account_number']).toBe(person.rekening);
  });
});
