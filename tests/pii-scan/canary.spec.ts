import { CANARY_ATTRIBUTES, buildCanary } from './canary';

// Seam: buildCanary(index). K-24 formats from docs/spec/pengujian-dan-pengukuran.md 6; the patterns below are written
// out in the test on purpose, so the builder is checked against the spec and not against itself.
const FORMATS = {
  customer_id: /^CUST-[0-9]{6}$/,
  nik: /^9999[0-9]{12}$/,
  hp: /^08999[0-9]{7}$/,
  rekening: /^9999[0-9]{6}$/,
  email: /^canary-[0-9]+@example\.test$/,
  nama: /^Kenari [A-Za-z]+$/,
} as const;

describe('M2-10 canary values (K-24)', () => {
  it.each(CANARY_ATTRIBUTES)('M2-10 K-24 %s has the valid-but-false format', (attribute) => {
    for (const index of [0, 1, 7, 999]) {
      expect(buildCanary(index)[attribute]).toMatch(FORMATS[attribute]);
    }
  });

  it('M2-10 K-24 the six attributes are the identifiers of PRD 18.2', () => {
    expect([...CANARY_ATTRIBUTES].sort()).toEqual(
      ['customer_id', 'email', 'hp', 'nama', 'nik', 'rekening'].sort(),
    );
  });

  it.each(CANARY_ATTRIBUTES)('M2-10 K-24 %s is unique per customer', (attribute) => {
    const values = Array.from({ length: 2000 }, (_, index) => buildCanary(index)[attribute]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('M2-10 K-24 no value of one attribute appears inside a value of another or of another customer', () => {
    const all = Array.from({ length: 200 }, (_, index) => Object.values(buildCanary(index))).flat();
    for (const value of all) {
      expect(all.filter((other) => other.includes(value))).toEqual([value]);
    }
  });

  it('M2-10 K-24 the same index always gives the same canary (deterministic tests)', () => {
    expect(buildCanary(5)).toEqual(buildCanary(5));
  });

  it('M2-10 K-24 refuses an index that is not a non-negative safe integer', () => {
    expect(() => buildCanary(-1)).toThrow();
    expect(() => buildCanary(1.5)).toThrow();
  });
});
