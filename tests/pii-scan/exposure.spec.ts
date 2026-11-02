import { averages, exposureOf, relativeReduction, type Observation } from './exposure';

// M6-02 seam: the arithmetic of E(s) = |P(s)| / 6 over observations (service, attribute, place), never over values.
const seen = (
  service: string,
  attribute: Observation['attribute'],
  place: Observation['place'],
): Observation => ({
  service,
  attribute,
  place,
});

describe('M6-02 exposureOf', () => {
  it('M6-02 E(s) counts an attribute once however many places hold it', () => {
    const result = exposureOf(
      [
        seen('fraud', 'nik', 'database'),
        seen('fraud', 'nik', 'payload'),
        seen('fraud', 'nama', 'log'),
      ],
      'fraud',
    );
    expect(result.attributes).toEqual(['nik', 'nama']);
    expect(result.e).toBeCloseTo(2 / 6);
  });

  it('M6-02 other services do not count for this one', () => {
    expect(exposureOf([seen('transaction', 'hp', 'log')], 'fraud').e).toBe(0);
  });

  it('M6-02 E_umum is over the five general identifiers and E_spesifik over the account number', () => {
    const result = exposureOf(
      [seen('transaction', 'customer_id', 'payload'), seen('transaction', 'rekening', 'payload')],
      'transaction',
    );
    expect(result.eUmum).toBeCloseTo(1 / 5);
    expect(result.eSpesifik).toBe(1);
  });

  it('M6-02 the places that hold each attribute are kept apart', () => {
    const result = exposureOf(
      [seen('notification', 'hp', 'database'), seen('notification', 'hp', 'payload')],
      'notification',
    );
    expect(result.byPlace.database).toEqual(['hp']);
    expect(result.byPlace.payload).toEqual(['hp']);
    expect(result.byPlace.log).toEqual([]);
  });
});

describe('M6-02 averages and reduction', () => {
  it('M6-02 the mean is reported twice: every service with Auth, and only the services inside the zone', () => {
    const rows = [
      { service: 'transaction', e: 0 },
      { service: 'fraud', e: 0 },
      { service: 'notification', e: 1 / 6 },
      { service: 'reconciliation', e: 0 },
    ];
    const result = averages(rows, { service: 'auth', e: 2 / 6 });
    expect(result.inZone).toBeCloseTo(1 / 24);
    expect(result.all).toBeCloseTo((1 / 6 + 2 / 6) / 5);
  });

  it('M6-02 relative reduction is (baseline - proposed) / baseline, and undefined when baseline is zero', () => {
    expect(relativeReduction(0.5, 0.125)).toBeCloseTo(0.75);
    expect(relativeReduction(0, 0)).toBeNull();
  });
});
