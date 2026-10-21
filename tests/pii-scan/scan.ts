import { CANARY_ATTRIBUTES, type Canary, type CanaryAttribute } from './canary';

/**
 * What a scan reports: where a canary was seen, never its value (docs/spec/pengujian-dan-pengukuran.md 6). The scanner
 * itself must not become a place where personal data leaks, so there is no field that could hold one.
 */
export interface Finding {
  readonly attribute: CanaryAttribute;
  readonly location: string;
  readonly service: string;
}

export interface ScanContext {
  readonly service: string;
  readonly location: string;
}

function decoded(text: string): string | undefined {
  try {
    const plain = decodeURIComponent(text);
    return plain === text ? undefined : plain;
  } catch {
    return undefined;
  }
}

/** Exact match of every listed canary, also in the percent-decoded form (a value in a URL). One finding per attribute. */
export function scanText(
  text: string,
  canaries: readonly Canary[],
  context: ScanContext,
): Finding[] {
  const views = [text, decoded(text)].filter((view): view is string => view !== undefined);
  return CANARY_ATTRIBUTES.filter((attribute) =>
    canaries.some((canary) => views.some((view) => view.includes(canary[attribute]))),
  ).map((attribute) => ({ attribute, location: context.location, service: context.service }));
}

/** Fails a test when there is a finding. The message names attribute, location and service only. */
export function assertNoFindings(findings: readonly Finding[]): void {
  if (findings.length === 0) return;
  const lines = findings.map((f) => `${f.attribute} in ${f.location} of ${f.service}`);
  throw new Error(`canary values leaked: ${lines.join('; ')}`);
}
