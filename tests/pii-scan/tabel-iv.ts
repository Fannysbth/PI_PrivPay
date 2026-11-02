import { CANARY_ATTRIBUTES, type CanaryAttribute } from './canary';
import {
  exposureOf,
  ZONE_SERVICES,
  type Mode,
  type Observation,
  type ZoneService,
} from './exposure';

// M6-02: the EXPECTATION of Tabel IV (Metodologi D.2) as data, and the comparison of an observation with it. It is a separate
// file on purpose: nothing that counts what a scan found imports it, so no expected value can steer a count. It was written
// before any run, and a difference between it and what was observed is a finding that is reported, never tuned.

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
