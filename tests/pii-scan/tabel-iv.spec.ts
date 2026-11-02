import { EXPECTED_P, compareWithExpected } from './tabel-iv';
import type { Observation } from './exposure';

const seen = (
  service: string,
  attribute: Observation['attribute'],
  place: Observation['place'],
): Observation => ({ service, attribute, place });

describe('M6-02 compareWithExpected (Tabel IV)', () => {
  it('M6-02 Tabel IV is the table of the methodology, as data', () => {
    expect(EXPECTED_P.proposed.notification).toEqual(['hp']);
    expect(EXPECTED_P.proposed.transaction).toEqual([]);
    expect(EXPECTED_P.baseline.notification).toHaveLength(5);
    expect(EXPECTED_P.baseline.transaction).toEqual(['customer_id', 'nik', 'nama', 'rekening']);
  });

  it('M6-02 a perfect match has precision and recall 1 and no difference', () => {
    const observations = EXPECTED_P.proposed.notification.map((a) =>
      seen('notification', a, 'database'),
    );
    const row = compareWithExpected('proposed', observations).find(
      (r) => r.service === 'notification',
    );
    expect(row).toMatchObject({
      match: true,
      precision: 1,
      recall: 1,
      missing: [],
      unexpected: [],
    });
  });

  it('M6-02 an expected attribute that was not seen is reported as missing, and recall drops', () => {
    const observations = [
      seen('transaction', 'customer_id', 'database'),
      seen('transaction', 'nik', 'database'),
    ];
    const row = compareWithExpected('baseline', observations).find(
      (r) => r.service === 'transaction',
    );
    expect(row?.missing).toEqual(['nama', 'rekening']);
    expect(row?.unexpected).toEqual([]);
    expect(row?.match).toBe(false);
    expect(row?.recall).toBe(1);
    expect(row?.precision).toBeCloseTo(2 / 4);
  });

  it('M6-02 an attribute seen where the table expects none is reported as unexpected', () => {
    const row = compareWithExpected('proposed', [seen('fraud', 'email', 'log')]).find(
      (r) => r.service === 'fraud',
    );
    expect(row?.unexpected).toEqual(['email']);
    expect(row?.match).toBe(false);
    expect(row?.observedE).toBeCloseTo(1 / 6);
    expect(row?.expectedE).toBe(0);
  });

  it('M6-02 nothing expected and nothing seen is a match with precision and recall 1', () => {
    const row = compareWithExpected('proposed', []).find((r) => r.service === 'fraud');
    expect(row).toMatchObject({ match: true, precision: 1, recall: 1 });
  });

  it('M6-02 it never changes the observations: the same input gives the same rows', () => {
    const observations = [seen('transaction', 'nik', 'payload')];
    expect(compareWithExpected('baseline', observations)).toEqual(
      compareWithExpected('baseline', observations),
    );
  });
});
