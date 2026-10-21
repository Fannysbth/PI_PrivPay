import type { AuditEntry, AuditedResult } from '../src/audit';

// FR-15, spec privacy 9.2: the type has no place for an identity value. ts-jest type-checks this file, so a
// `@ts-expect-error` that stops being an error (the type grew a field for values) fails the test run.
const base: AuditEntry = {
  action: 'DE_PSEUDONYMIZE',
  status: 'SUCCESS',
  reason: 'OK',
  requestingService: 'API_GATEWAY',
};

describe('M2-04 FR-15 AuditEntry cannot hold identity values', () => {
  it('M2-04 FR-15 refuses fields for values and attribute names outside customer_id, nik and nama', () => {
    // @ts-expect-error no field for a subject, a customer id or any attribute value
    const withSubject: AuditEntry = { ...base, subjectId: 'x' };
    // @ts-expect-error attribute_names are names of the three openable attributes only
    const withHp: AuditEntry = { ...base, attributeNames: ['hp'] };
    // @ts-expect-error free text in the reason would be a channel for values
    const withFreeReason: AuditEntry = { ...base, reason: 'nik 0000 was opened' };
    expect([withSubject, withHp, withFreeReason]).toHaveLength(3);
  });

  it('M2-04 FR-15 accepts the attribute names that audit_log allows', () => {
    const ok: AuditEntry = { ...base, attributeNames: ['customer_id', 'nik', 'nama'] };
    expect(ok.attributeNames).toEqual(['customer_id', 'nik', 'nama']);
  });
});

const committed = (audit: AuditedResult<null>['audit']): unknown => audit;

describe('M2-04 FR-13 a success row is a SUCCESS row', () => {
  it('M2-04 FR-13 AuditedResult refuses a DENIED row or a reason other than OK', () => {
    // @ts-expect-error a committed state change cannot carry a DENIED row
    const denied = committed({ ...base, status: 'DENIED', reason: 'EXPIRED' });
    // @ts-expect-error a SUCCESS row has the reason OK or REUSED_ACTIVE, never a denial reason
    const reasoned = committed({ ...base, reason: 'EXPIRED' });
    const ok = committed({ ...base, status: 'SUCCESS', reason: 'OK' });
    expect([denied, reasoned, ok]).toHaveLength(3);
  });

  it('M2-05 FR-13 a reused active token is a success with the reason REUSED_ACTIVE (spec privacy 7.3)', () => {
    const reused = committed({ ...base, status: 'SUCCESS', reason: 'REUSED_ACTIVE' });
    expect(reused).toMatchObject({ reason: 'REUSED_ACTIVE' });
  });
});
