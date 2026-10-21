import { DomainError, type HttpClient, type HttpRequest } from '@privpay/common';
import { HttpPrivacyClient, HttpSmsGateway } from '../src/notification';

// Seam: the two HTTP adapters of Notification, against a fake HttpClient that records the request and gives a chosen
// answer. What counts is what is asked (the path, the token, the idempotent flag that decides about retries) and that
// anything which is not a clear answer is a failure. The values are invented.
const PHONE = '081200000042';
const TEXT = 'Transaksi Rp35000 berhasil.';

function fake(status: number, body: unknown) {
  const sent: HttpRequest[] = [];
  const http: HttpClient = {
    request: (request) => {
      sent.push(request);
      return Promise.resolve({ status, body });
    },
  };
  return { http, sent };
}
const token = { get: () => Promise.resolve('service-token') };
const failure = async (work: Promise<unknown>): Promise<DomainError | undefined> => {
  try {
    await work;
  } catch (error) {
    return error as DomainError;
  }
  return undefined;
};

describe('M4-05 FR-08 HttpPrivacyClient', () => {
  it('M4-05 FR-08 it asks POST /resolve-domain with the notification token, as an idempotent call with its own token', async () => {
    const { http, sent } = fake(200, { notification_domain_id: 'PSEU-D0A1B2C3' });
    const domain = await new HttpPrivacyClient({ http, serviceToken: token }).resolveDomain(
      'PSEU-1111AAAA',
    );
    expect(domain).toBe('PSEU-D0A1B2C3');
    expect(sent).toEqual([
      {
        service: 'privacy-service',
        method: 'POST',
        path: '/resolve-domain',
        body: { notif_token: 'PSEU-1111AAAA' },
        idempotent: true,
        authorization: 'Bearer service-token',
      },
    ]);
  });

  it.each([
    [403, { error: { reason: 'SERVICE_MISMATCH' } }],
    [404, { error: { reason: 'TOKEN_NOT_FOUND' } }],
    [410, { error: { reason: 'EXPIRED' } }],
    [500, {}],
    [200, {}],
    [200, { notification_domain_id: 'CUST-000101' }],
    [403, { notification_domain_id: 'PSEU-D0A1B2C3' }],
    [404, { notification_domain_id: 'PSEU-D0A1B2C3' }],
  ])(
    'M4-05 FR-20 an answer of %s that is not a domain token is a failure',
    async (status, body) => {
      const { http } = fake(status, body);
      const error = await failure(
        new HttpPrivacyClient({ http, serviceToken: token }).resolveDomain('PSEU-1111AAAA'),
      );
      expect(error?.reason).toBe('SERVICE_UNAVAILABLE');
    },
  );
});

describe('M4-05 FR-20 HttpSmsGateway', () => {
  it('M4-05 FR-20 it asks POST /sms as a call that is never repeated, with its own token', async () => {
    const { http, sent } = fake(202, { accepted: true });
    await new HttpSmsGateway({ http, serviceToken: token }).send(PHONE, TEXT);
    expect(sent).toEqual([
      {
        service: 'sms-simulator',
        method: 'POST',
        path: '/sms',
        body: { to: PHONE, text: TEXT },
        idempotent: false,
        authorization: 'Bearer service-token',
      },
    ]);
  });

  it.each([[200], [204], [400], [403], [422], [500]])(
    'M4-05 FR-20 an answer of %s is not "accepted" and is a failure that does not repeat the phone or the text',
    async (status) => {
      const { http } = fake(status, { echo: PHONE });
      const error = await failure(
        new HttpSmsGateway({ http, serviceToken: token }).send(PHONE, TEXT),
      );
      expect(error?.reason).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify([error?.message, error?.cause])).not.toContain(PHONE);
      expect(JSON.stringify([error?.message, error?.cause])).not.toContain('Rp35000');
    },
  );
});
