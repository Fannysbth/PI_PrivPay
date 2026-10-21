import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '@privpay/common';
import { PolicyEngine, type Operation, type PolicyContext } from '../src/policy';

// Seam: PolicyEngine's public interface, pure (no I/O). The oracle is the PRD tables written out below as literals,
// not computed the way the code computes them (tdd: no tautology). FR-04, FR-27, FR-28; TK-06, TK-13, TK-14, TK-15.
const TTL = {
  PAYMENT_PROCESSING: 111,
  FRAUD_DETECTION: 222,
  NOTIFICATION: 333,
  NOTIFICATION_REGISTRATION: 444,
  DAILY_RECONCILIATION: 555,
  INTERNAL_AUDIT: 666,
};
const engine = new PolicyEngine(TTL);

type Row = [
  id: string,
  service: string,
  purpose: string,
  subject: string,
  open: boolean,
  role: string,
];
/** PRD Tabel 1. */
const TABLE_1: Row[] = [
  ['P1', 'TRANSACTION', 'PAYMENT_PROCESSING', 'CUSTOMER', false, 'service'],
  ['P2', 'TRANSACTION', 'PAYMENT_PROCESSING', 'ACCOUNT', false, 'service'],
  ['P3', 'FRAUD', 'FRAUD_DETECTION', 'CUSTOMER', false, 'service'],
  ['P4', 'NOTIFICATION', 'NOTIFICATION', 'CUSTOMER', false, 'service'],
  ['P5', 'NOTIFICATION', 'NOTIFICATION_REGISTRATION', 'CUSTOMER', false, 'service'],
  ['P6', 'RECONCILIATION', 'DAILY_RECONCILIATION', 'ACCOUNT', false, 'service'],
  ['P7', 'RECONCILIATION', 'INTERNAL_AUDIT', 'CUSTOMER', true, 'auditor'],
];
const keyOf = ([, serviceId, purpose, subjectType]: Row) => ({ serviceId, purpose, subjectType });

/** PRD Tabel 3, for the operations of this engine: who may call, and which contexts they may touch. */
const TABLE_3: Record<
  Exclude<Operation, 'RESOLVE_NOTIF_DOMAIN' | 'EXCHANGE' | 'UPDATE_TX_STATUS'>,
  { caller: string; contexts: string[] }
> = {
  GENERATE_FROM_IDENTITY: { caller: 'API_GATEWAY', contexts: ['P1', 'P2', 'P5', 'P6'] },
  GENERATE_FROM_TRANSACTION: { caller: 'RECONCILIATION', contexts: ['P6', 'P7'] },
  DE_PSEUDONYMIZE: { caller: 'RECONCILIATION', contexts: ['P7'] },
  RE_ISSUE: { caller: 'TRANSACTION', contexts: ['P1', 'P2'] },
};
const CONTEXT_OPERATIONS = Object.keys(TABLE_3) as (keyof typeof TABLE_3)[];
const CALLERS = [
  'API_GATEWAY',
  'TRANSACTION',
  'FRAUD',
  'NOTIFICATION',
  'RECONCILIATION',
  'ADMIN_CONSOLE',
  'UNKNOWN',
];
const SERVICES = [
  'TRANSACTION',
  'FRAUD',
  'NOTIFICATION',
  'RECONCILIATION',
  'API_GATEWAY',
  'ADMIN_CONSOLE',
  'OTHER',
];
const PURPOSES = [
  'PAYMENT_PROCESSING',
  'FRAUD_DETECTION',
  'NOTIFICATION',
  'NOTIFICATION_REGISTRATION',
  'DAILY_RECONCILIATION',
  'INTERNAL_AUDIT',
  'MARKETING',
];
const SUBJECTS = ['CUSTOMER', 'ACCOUNT'];

function failure(work: () => unknown): { reason?: string } {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return { reason: error.reason };
    throw error;
  }
  return {};
}

describe('M2-03 FR-04 Tabel 1 is the PRD table, and its TTLs come from configuration', () => {
  it('M2-03 FR-04 the seven contexts are exactly P1..P7 of the PRD', () => {
    const actual = engine
      .contexts()
      .map((c) => [c.id, c.serviceId, c.purpose, c.subjectType, c.mayDisclose, c.requiredRole]);
    expect(actual).toEqual(TABLE_1);
  });

  it('M2-03 FR-04 takes each TTL from the injected configuration, never a literal', () => {
    const byPurpose = Object.fromEntries(engine.contexts().map((c) => [c.purpose, c.ttlSeconds]));
    expect(byPurpose).toEqual(TTL);
  });

  it.each([
    ['a missing purpose', { ...TTL, INTERNAL_AUDIT: undefined }],
    ['zero', { ...TTL, INTERNAL_AUDIT: 0 }],
    ['negative', { ...TTL, FRAUD_DETECTION: -1 }],
    ['fractional', { ...TTL, NOTIFICATION: 1.5 }],
    ['not a number', { ...TTL, NOTIFICATION: Number.NaN }],
    ['infinite', { ...TTL, NOTIFICATION: Number.POSITIVE_INFINITY }],
    ['a string', { ...TTL, NOTIFICATION: '900' }],
  ])('M2-03 FR-04 refuses a TTL configuration with %s at start', (_name, ttl) => {
    expect(() => new PolicyEngine(ttl as never)).toThrow(RangeError);
  });

  it('M2-03 FR-04 the contexts cannot be changed by a caller', () => {
    const first = engine.contexts();
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every((c) => Object.isFrozen(c))).toBe(true);
    expect(() => {
      (first[0] as { ttlSeconds: number }).ttlSeconds = 1;
    }).toThrow(TypeError);
    expect(engine.contexts()[0]?.ttlSeconds).toBe(TTL.PAYMENT_PROCESSING);
  });
});

describe('M2-03 FR-04 evaluate allows exactly the combinations of Tabel 1 and Tabel 3', () => {
  it('M2-03 FR-04 every allowed operation returns the context it touches', () => {
    for (const operation of CONTEXT_OPERATIONS) {
      const { caller, contexts } = TABLE_3[operation];
      for (const id of contexts) {
        const row = TABLE_1.find((r) => r[0] === id) as Row;
        const context: PolicyContext = engine.evaluate({
          operation,
          requestingService: caller,
          context: keyOf(row),
          actorRole: 'auditor',
        });
        expect(context.id).toBe(id);
      }
    }
  });

  it('M2-03 FR-04 refuses every other caller, service, purpose and subject type with POLICY_NOT_ALLOWED', () => {
    const wrong: string[] = [];
    for (const operation of CONTEXT_OPERATIONS) {
      for (const requestingService of CALLERS) {
        for (const serviceId of SERVICES) {
          for (const purpose of PURPOSES) {
            for (const subjectType of SUBJECTS) {
              const row = TABLE_1.find(
                (r) => r[1] === serviceId && r[2] === purpose && r[3] === subjectType,
              );
              const allowed =
                requestingService === TABLE_3[operation].caller &&
                row !== undefined &&
                TABLE_3[operation].contexts.includes(row[0]);
              const outcome = failure(() =>
                engine.evaluate({
                  operation,
                  requestingService,
                  context: { serviceId, purpose, subjectType },
                  actorRole: 'auditor',
                }),
              );
              const expected = allowed ? undefined : 'POLICY_NOT_ALLOWED';
              if (outcome.reason !== expected) {
                wrong.push(
                  `${operation} ${requestingService} ${serviceId}/${purpose}/${subjectType}`,
                );
              }
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('M2-03 TK-06 a purpose outside the whitelist is POLICY_NOT_ALLOWED, however it is spelled', () => {
    const odd = [
      'MARKETING',
      'payment_processing',
      ' PAYMENT_PROCESSING',
      'PAYMENT_PROCESSING\n',
      '',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ];
    for (const purpose of odd) {
      expect(
        failure(() =>
          engine.evaluate({
            operation: 'GENERATE_FROM_IDENTITY',
            requestingService: 'API_GATEWAY',
            context: { serviceId: 'TRANSACTION', purpose, subjectType: 'CUSTOMER' },
          }),
        ).reason,
      ).toBe('POLICY_NOT_ALLOWED');
    }
    for (const serviceId of ['__proto__', 'constructor', 'TRANSACTION ', 'transaction', '']) {
      expect(
        failure(() =>
          engine.evaluate({
            operation: 'GENERATE_FROM_IDENTITY',
            requestingService: 'API_GATEWAY',
            context: { serviceId, purpose: 'PAYMENT_PROCESSING', subjectType: 'CUSTOMER' },
          }),
        ).reason,
      ).toBe('POLICY_NOT_ALLOWED');
    }
    for (const requestingService of ['__proto__', 'constructor', 'api_gateway', '']) {
      expect(
        failure(() => {
          engine.authorizeCaller('GENERATE_FROM_IDENTITY', requestingService);
        }).reason,
      ).toBe('POLICY_NOT_ALLOWED');
    }
  });

  it('M2-03 FR-27 TK-14 FRAUD cannot get a token for an ACCOUNT, and only API_GATEWAY may hand over a raw subject', () => {
    const fraudAccount = { serviceId: 'FRAUD', purpose: 'FRAUD_DETECTION', subjectType: 'ACCOUNT' };
    expect(
      failure(() =>
        engine.evaluate({
          operation: 'GENERATE_FROM_IDENTITY',
          requestingService: 'API_GATEWAY',
          context: fraudAccount,
        }),
      ).reason,
    ).toBe('POLICY_NOT_ALLOWED');
    const p1 = keyOf(TABLE_1[0] as Row);
    expect(
      failure(() =>
        engine.evaluate({
          operation: 'GENERATE_FROM_IDENTITY',
          requestingService: 'TRANSACTION',
          context: p1,
        }),
      ).reason,
    ).toBe('POLICY_NOT_ALLOWED');
  });

  it('M2-03 FR-04 RESOLVE_NOTIF_DOMAIN is for NOTIFICATION only (PRD 7.3 STEP 0)', () => {
    expect(
      failure(() => {
        engine.authorizeCaller('RESOLVE_NOTIF_DOMAIN', 'NOTIFICATION');
      }).reason,
    ).toBeUndefined();
    for (const caller of CALLERS.filter((c) => c !== 'NOTIFICATION')) {
      expect(
        failure(() => {
          engine.authorizeCaller('RESOLVE_NOTIF_DOMAIN', caller);
        }).reason,
      ).toBe('POLICY_NOT_ALLOWED');
    }
  });

  it('M2-07 AZ-24 UPDATE_TX_STATUS and RE_ISSUE are for TRANSACTION only (PRD Tabel 3)', () => {
    for (const operation of ['UPDATE_TX_STATUS', 'RE_ISSUE'] as const) {
      expect(
        failure(() => {
          engine.authorizeCaller(operation, 'TRANSACTION');
        }).reason,
      ).toBeUndefined();
      for (const caller of CALLERS.filter((c) => c !== 'TRANSACTION')) {
        expect(
          failure(() => {
            engine.authorizeCaller(operation, caller);
          }).reason,
        ).toBe('POLICY_NOT_ALLOWED');
      }
    }
  });
});

describe('M2-03 FR-04 the auditor role is required for P7', () => {
  const p7 = keyOf(TABLE_1[6] as Row);
  const operations = ['GENERATE_FROM_TRANSACTION', 'DE_PSEUDONYMIZE'] as const;

  it.each(operations)(
    'M2-03 FR-04 %s on P7 without the auditor role is FORBIDDEN_ROLE',
    (operation) => {
      for (const actorRole of [undefined, 'admin', 'fraud_analyst', 'AUDITOR', '', 'auditor ']) {
        expect(
          failure(() =>
            engine.evaluate({
              operation,
              requestingService: 'RECONCILIATION',
              context: p7,
              actorRole,
            }),
          ).reason,
        ).toBe('FORBIDDEN_ROLE');
      }
      expect(
        failure(() =>
          engine.evaluate({
            operation,
            requestingService: 'RECONCILIATION',
            context: p7,
            actorRole: 'auditor',
          }),
        ).reason,
      ).toBeUndefined();
    },
  );

  it('M2-03 FR-04 the caller and the way of issue are checked before the role', () => {
    expect(
      failure(() =>
        engine.evaluate({
          operation: 'GENERATE_FROM_TRANSACTION',
          requestingService: 'FRAUD',
          context: p7,
        }),
      ).reason,
    ).toBe('POLICY_NOT_ALLOWED');
    expect(
      failure(() =>
        engine.evaluate({
          operation: 'GENERATE_FROM_IDENTITY',
          requestingService: 'API_GATEWAY',
          context: p7,
        }),
      ).reason,
    ).toBe('POLICY_NOT_ALLOWED');
  });

  it('M2-03 FR-04 contexts that need only a service do not look at the role', () => {
    const p6 = keyOf(TABLE_1[5] as Row);
    expect(
      failure(() =>
        engine.evaluate({
          operation: 'GENERATE_FROM_TRANSACTION',
          requestingService: 'RECONCILIATION',
          context: p6,
        }),
      ).reason,
    ).toBeUndefined();
  });
});

describe('M2-03 FR-28 TK-13 only the two exchanges of Tabel 2 are allowed', () => {
  it('M2-03 FR-28 STEP 0: TRANSACTION may ask for a token of FRAUD or NOTIFICATION, nobody else for anything', () => {
    const fraud = engine.exchangeTarget('TRANSACTION', {
      serviceId: 'FRAUD',
      purpose: 'FRAUD_DETECTION',
    });
    const notification = engine.exchangeTarget('TRANSACTION', {
      serviceId: 'NOTIFICATION',
      purpose: 'NOTIFICATION',
    });
    expect([fraud.id, notification.id]).toEqual(['P3', 'P4']);
    const wrong: string[] = [];
    for (const caller of CALLERS) {
      for (const serviceId of SERVICES) {
        for (const purpose of PURPOSES) {
          const allowed =
            caller === 'TRANSACTION' &&
            ((serviceId === 'FRAUD' && purpose === 'FRAUD_DETECTION') ||
              (serviceId === 'NOTIFICATION' && purpose === 'NOTIFICATION'));
          const reason = failure(() =>
            engine.exchangeTarget(caller, { serviceId, purpose }),
          ).reason;
          if (reason !== (allowed ? undefined : 'POLICY_NOT_ALLOWED'))
            wrong.push(`${caller} ${serviceId}/${purpose}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('M2-03 TK-13 STEP 2: of all 7 x 7 pairs of contexts only P1 to P3 and P1 to P4 by TRANSACTION are allowed', () => {
    const wrong: string[] = [];
    for (const caller of CALLERS) {
      for (const source of TABLE_1) {
        for (const target of TABLE_1) {
          const allowed =
            caller === 'TRANSACTION' &&
            source[0] === 'P1' &&
            (target[0] === 'P3' || target[0] === 'P4');
          if (engine.exchangeAllowed(keyOf(source), keyOf(target), caller) !== allowed) {
            wrong.push(`${caller} ${source[0]}->${target[0]}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('M2-03 TK-13 FRAUD exchanging its token to NOTIFICATION is refused, and so is anything with an unknown context', () => {
    const p3 = keyOf(TABLE_1[2] as Row);
    const p4 = keyOf(TABLE_1[3] as Row);
    expect(engine.exchangeAllowed(p3, p4, 'FRAUD')).toBe(false);
    expect(engine.exchangeAllowed(p3, p4, 'TRANSACTION')).toBe(false);
    expect(
      engine.exchangeAllowed({ serviceId: 'X', purpose: 'Y', subjectType: 'Z' }, p4, 'TRANSACTION'),
    ).toBe(false);
    expect(
      engine.exchangeAllowed(
        keyOf(TABLE_1[0] as Row),
        { serviceId: '__proto__', purpose: 'x', subjectType: 'CUSTOMER' },
        'TRANSACTION',
      ),
    ).toBe(false);
  });
});

describe('M2-03 FR-04 TK-15 a context can be opened only if it is P7', () => {
  it('M2-03 TK-15 FRAUD opening its own token is POLICY_NOT_ALLOWED', () => {
    const p3 = keyOf(TABLE_1[2] as Row);
    expect(
      failure(() =>
        engine.evaluate({
          operation: 'DE_PSEUDONYMIZE',
          requestingService: 'FRAUD',
          context: p3,
          actorRole: 'auditor',
        }),
      ).reason,
    ).toBe('POLICY_NOT_ALLOWED');
  });

  it('M2-03 FR-04 RECONCILIATION itself cannot open any context but P7, role or not', () => {
    for (const row of TABLE_1.filter((r) => r[0] !== 'P7')) {
      for (const actorRole of ['auditor', 'admin', undefined]) {
        expect(
          failure(() =>
            engine.evaluate({
              operation: 'DE_PSEUDONYMIZE',
              requestingService: 'RECONCILIATION',
              context: keyOf(row),
              actorRole,
            }),
          ).reason,
        ).toBe('POLICY_NOT_ALLOWED');
      }
    }
  });

  it('M2-03 FR-04 mayDisclose is true for P7 and for no other context', () => {
    const open = engine
      .contexts()
      .filter((c) => c.mayDisclose)
      .map((c) => c.id);
    expect(open).toEqual(['P7']);
  });

  it('M2-03 FR-04 contextOf finds the context of a stored mapping, and nothing for a combination outside Tabel 1', () => {
    for (const row of TABLE_1) expect(engine.contextOf(keyOf(row))?.id).toBe(row[0]);
    expect(
      engine.contextOf({
        serviceId: 'TRANSACTION',
        purpose: 'NOTIFICATION',
        subjectType: 'CUSTOMER',
      }),
    ).toBeUndefined();
    expect(
      engine.contextOf({ serviceId: '__proto__', purpose: '__proto__', subjectType: '__proto__' }),
    ).toBeUndefined();
  });
});

describe('M2-03 FR-04 Tabel 5 and Tabel 6', () => {
  it('M2-03 FR-04 only P7 yields attributes, only customer_id, nik and nama, never phone or account number', () => {
    for (const row of TABLE_1) {
      const attributes = engine.attributesFor(keyOf(row));
      expect(attributes).toEqual(row[0] === 'P7' ? ['customer_id', 'nik', 'nama'] : []);
    }
    expect(engine.attributesFor({ serviceId: 'X', purpose: 'Y', subjectType: 'Z' })).toEqual([]);
    expect(Object.isFrozen(engine.attributesFor(keyOf(TABLE_1[6] as Row)))).toBe(true);
  });

  it('M2-03 FR-04 the legitimate bases are DISPUTE, FRAUD_CONFIRMED and LEGAL_REQUEST, spelled exactly', () => {
    for (const basis of ['DISPUTE', 'FRAUD_CONFIRMED', 'LEGAL_REQUEST'])
      expect(engine.isValidBasis(basis)).toBe(true);
    for (const basis of [
      'dispute',
      'OTHER',
      '',
      'DISPUTE ',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(engine.isValidBasis(basis)).toBe(false);
    }
  });
});

describe('M2-03 FR-04 the engine is pure', () => {
  it('M2-03 FR-04 the policy sources import nothing but @privpay/common types and local files, and no clock or randomness', () => {
    const dir = join(__dirname, '..', 'src', 'policy');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const target = match[1] ?? '';
        expect(['@privpay/common', '../audit'].includes(target) || target.startsWith('./')).toBe(
          true,
        );
      }
      expect(source).not.toMatch(/Date\.now|new Date|Math\.random|process\.env|node:/);
    }
  });
});
