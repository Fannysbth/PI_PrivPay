import { CANARY_ATTRIBUTES, type CanaryAttribute } from './canary';

// M6-02 (Metodologi D.2, Tabel IV; docs/spec/pengujian-dan-pengukuran.md 6): E(s) = |P(s)| / 6 over what a scan OBSERVED.
// This module only does arithmetic over (service, attribute, place) observations; it never sees a value. The expected sets
// below are the table as data, written before any run. They are an expectation to be compared against, not a target:
// a difference is a finding and is reported as it is.

export type Mode = 'baseline' | 'proposed';
export type Place = 'payload' | 'database' | 'log';
export const PLACES: readonly Place[] = ['payload', 'database', 'log'];

export const ZONE_SERVICES = ['transaction', 'fraud', 'notification', 'reconciliation'] as const;
export type ZoneService = (typeof ZONE_SERVICES)[number];

export interface Observation {
  readonly service: string;
  readonly attribute: CanaryAttribute;
  readonly place: Place;
}

/** Tabel IV. The phone of Notification is counted as exposed in both modes (the conservative reading of the methodology). */
export const EXPECTED_P: Readonly<
  Record<Mode, Readonly<Record<ZoneService, readonly CanaryAttribute[]>>>
> = {
  baseline: {
    transaction: ['customer_id', 'nik', 'nama', 'rekening'],
    fraud: ['customer_id', 'nik', 'nama', 'rekening'],
    notification: ['customer_id', 'nik', 'nama', 'rekening', 'hp'],
    reconciliation: ['customer_id', 'nik', 'nama', 'rekening'],
  },
  proposed: {
    transaction: [],
    fraud: [],
    notification: ['hp'],
    reconciliation: [],
  },
};

/** Per data class (docs/spec/pengujian-dan-pengukuran.md 6): the five general identifiers, and the account number. */
const UMUM: readonly CanaryAttribute[] = ['nama', 'nik', 'hp', 'email', 'customer_id'];
const SPESIFIK: readonly CanaryAttribute[] = ['rekening'];

export interface Exposure {
  readonly service: string;
  readonly attributes: CanaryAttribute[];
  readonly e: number;
  readonly eUmum: number;
  readonly eSpesifik: number;
  readonly byPlace: Record<Place, CanaryAttribute[]>;
}

const inOrder = (attributes: ReadonlySet<CanaryAttribute>): CanaryAttribute[] =>
  CANARY_ATTRIBUTES.filter((attribute) => attributes.has(attribute));

export function exposureOf(observations: readonly Observation[], service: string): Exposure {
  const own = observations.filter((observation) => observation.service === service);
  const all = new Set(own.map((observation) => observation.attribute));
  const attributes = inOrder(all);
  const byPlace = { payload: [], database: [], log: [] } as Record<Place, CanaryAttribute[]>;
  for (const place of PLACES) {
    byPlace[place] = inOrder(
      new Set(own.filter((observation) => observation.place === place).map((o) => o.attribute)),
    );
  }
  return {
    service,
    attributes,
    e: attributes.length / CANARY_ATTRIBUTES.length,
    eUmum: attributes.filter((attribute) => UMUM.includes(attribute)).length / UMUM.length,
    eSpesifik:
      attributes.filter((attribute) => SPESIFIK.includes(attribute)).length / SPESIFIK.length,
    byPlace,
  };
}

export interface Comparison {
  readonly service: ZoneService;
  readonly expected: readonly CanaryAttribute[];
  readonly observed: readonly CanaryAttribute[];
  readonly expectedE: number;
  readonly observedE: number;
  readonly missing: CanaryAttribute[];
  readonly unexpected: CanaryAttribute[];
  readonly match: boolean;
  /** |expected ∩ observed| / |expected|; 1 when both are empty. */
  readonly precision: number;
  /** |expected ∩ observed| / |observed|; 1 when both are empty. */
  readonly recall: number;
}

const ratio = (hit: number, whole: number, bothEmpty: boolean): number =>
  whole === 0 ? (bothEmpty ? 1 : 0) : hit / whole;

export function compareWithExpected(
  mode: Mode,
  observations: readonly Observation[],
): Comparison[] {
  return ZONE_SERVICES.map((service) => {
    const expected = EXPECTED_P[mode][service];
    const observed = exposureOf(observations, service).attributes;
    const hit = observed.filter((attribute) => expected.includes(attribute)).length;
    const bothEmpty = expected.length === 0 && observed.length === 0;
    return {
      service,
      expected,
      observed,
      expectedE: expected.length / CANARY_ATTRIBUTES.length,
      observedE: observed.length / CANARY_ATTRIBUTES.length,
      missing: expected.filter((attribute) => !observed.includes(attribute)),
      unexpected: observed.filter((attribute) => !expected.includes(attribute)),
      match: expected.length === observed.length && hit === expected.length,
      precision: ratio(hit, expected.length, bothEmpty),
      recall: ratio(hit, observed.length, bothEmpty),
    };
  });
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Reported twice (Metodologi, Tabel IV): every service including Auth (outside the zone), and the services inside only. */
export function averages(
  zone: readonly { service: string; e: number }[],
  auth: { service: string; e: number },
): { all: number; inZone: number } {
  return {
    inZone: mean(zone.map((row) => row.e)),
    all: mean([...zone.map((row) => row.e), auth.e]),
  };
}

export function relativeReduction(baseline: number, proposed: number): number | null {
  return baseline === 0 ? null : (baseline - proposed) / baseline;
}
