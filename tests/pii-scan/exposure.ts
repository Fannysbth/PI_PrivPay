import { CANARY_ATTRIBUTES, type CanaryAttribute } from './canary';

// M6-02 (Metodologi D.2; docs/spec/pengujian-dan-pengukuran.md 6): E(s) = |P(s)| / 6 over what a scan OBSERVED.
// This module only counts observations (service, attribute, place); it never sees a value and it holds NO expected value.
// The expectation of Tabel IV is in tabel-iv.ts, which this module does not import (M6 decision 4b).

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
