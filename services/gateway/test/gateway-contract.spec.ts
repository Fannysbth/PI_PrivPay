import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError, isReason } from '@privpay/common';
import { buildCanary } from '../../../tests/pii-scan/canary';
import { assertNoFindings, scanText } from '../../../tests/pii-scan/scan';
import type { PrivacyPort, PseudonymizeRequest } from '../src/tokenizer/privacy-port';
import { Tokenizer } from '../src/tokenizer/tokenizer';

// The contract vectors of gateway spec 2: input (claims, body, Privacy's answers) -> output or error. The Tokenizer
// of the adapter passes them now, and the Lua plugin of Kong passes the same files (DK-02b, `pnpm test:edge`). Canary values are not in the
// files: `{{customer_id}}`, `{{rekening}}`, `{{nik}}`, `{{nama}}`, `{{email}}` are replaced from `canary` (K-24).
const DIR = join(__dirname, '..', '..', '..', 'tests', 'security', 'gateway-contract');

interface Vector {
  name: string;
  route: 'transaction' | 'settlement' | 'notification';
  canary: number;
  claims?: { customer_id: string };
  idempotency_key?: string;
  transaction_id?: string;
  body: unknown;
  privacy: { pseudonyms: Record<string, string>; errors: Record<string, string> };
  expect: { outbound?: unknown; error?: string; privacy_calls: number };
}

function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (_whole, name: string) => values[name] ?? '');
}

function load(file: string): Vector {
  const canary = buildCanary((JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Vector).canary);
  return JSON.parse(fill(readFileSync(join(DIR, file), 'utf8'), canary)) as Vector;
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));

describe('M2-11 gateway contract vectors', () => {
  it('M2-11 there are vectors for both routes and for the failures', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)('M2-11 %s', async (file) => {
    const vector = load(file);
    const calls: PseudonymizeRequest[] = [];
    const privacy: PrivacyPort = {
      pseudonymize: (request) => {
        calls.push(request);
        const key = `${request.subjectType}:${request.subjectId}`;
        const failure = vector.privacy.errors[key];
        if (failure !== undefined) {
          if (!isReason(failure)) throw new Error('the vector names an unknown reason');
          return Promise.reject(new DomainError(failure));
        }
        const pseudonym = vector.privacy.pseudonyms[key];
        return pseudonym === undefined
          ? Promise.reject(new DomainError('INTERNAL_ERROR', 'vector_without_answer'))
          : Promise.resolve(pseudonym);
      },
      // The vectors are of the two tokenizing routes; the registration is tested with the real IdP and Privacy.
      storeIdentity: () => Promise.resolve(),
      revokeCustomer: () => Promise.resolve(),
    };
    const tokenizer = new Tokenizer({
      privacy,
      newTransactionId: () => vector.transaction_id ?? 'TX-1',
    });
    const run = tokenizer.tokenize(
      vector.route === 'transaction'
        ? {
            route: 'transaction',
            claims: { customerId: vector.claims?.customer_id ?? '' },
            idempotencyKey: vector.idempotency_key ?? '',
            body: vector.body,
          }
        : vector.route === 'notification'
          ? {
              route: 'notification',
              claims: { customerId: vector.claims?.customer_id ?? '' },
              body: vector.body,
            }
          : { route: 'settlement', body: vector.body },
    );
    if (vector.expect.error !== undefined) {
      await expect(run).rejects.toMatchObject({ reason: vector.expect.error });
    } else {
      const result = await run;
      expect(result.outbound).toEqual(vector.expect.outbound);
      // Whatever the file says, the payload that leaves holds no canary of this vector (FR-02, FR-03).
      assertNoFindings(
        scanText(
          JSON.stringify(result.outbound),
          // The phone is the one value Notification must receive to send the message (Metodologi, flow 8): it is the
          // deliberate exception, so this route is held to every other attribute.
          [
            vector.route === 'notification'
              ? { ...buildCanary(vector.canary), hp: 'not-sent' }
              : buildCanary(vector.canary),
          ],
          {
            service: 'downstream',
            location: 'outbound',
          },
        ),
      );
    }
    expect(calls).toHaveLength(vector.expect.privacy_calls);
  });
});
