// Canary values (docs/spec/pengujian-dan-pengukuran.md 6, K-24): valid in format, plainly false, and generated from
// the customer index, never typed by hand. They exist only in test data.

export const CANARY_ATTRIBUTES = ['customer_id', 'nik', 'hp', 'rekening', 'email', 'nama'] as const;
export type CanaryAttribute = (typeof CANARY_ATTRIBUTES)[number];
export type Canary = Readonly<Record<CanaryAttribute, string>>;

/**
 * Below 100000 customers the digit blocks cannot run into each other: the account number (`9999` + 6 digits starting
 * with 0) is never a prefix of the NIK (`9999` + 5 + 11 digits), so one match never hides inside another value.
 */
export const MAX_CANARY_CUSTOMERS = 100_000;

const digits = (value: number, width: number): string => String(value).padStart(width, '0');

/** Six letters, base 26: a fixed width, so no name is the start of another. The spec's `<n>` is letters here because
 * the vault accepts no digit in a name (spec privacy 4.9). */
function letters(index: number): string {
  let rest = index;
  let out = '';
  for (let place = 0; place < 6; place += 1) {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function buildCanary(index: number): Canary {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CANARY_CUSTOMERS) {
    throw new RangeError('the canary index is outside 0..99999');
  }
  return Object.freeze({
    customer_id: `CUST-${digits(900_000 + index, 6)}`,
    nik: `99995${digits(index, 11)}`,
    hp: `08999${digits(index, 7)}`,
    rekening: `9999${digits(index, 6)}`,
    email: `canary-${String(index)}@example.test`,
    nama: `Kenari ${letters(index)}`,
  });
}
