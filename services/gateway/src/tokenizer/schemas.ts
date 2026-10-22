import { z } from 'zod';

// Formats of platform-dan-ci.md 3.1 and gateway spec 3 (K-16). One source for the route table and the tokenizer.
export const ACCOUNT_NUMBER = /^[0-9]{8,20}$/;
export const TRANSACTION_ID = /^TX-[0-9]{1,29}$/;
export const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MERCHANT_ID = /^MRC-[0-9]{3,}$/;
const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;
const BANK_REFERENCE = /^[A-Z0-9-]{1,32}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const isRealDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const amount = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * `nik`, `nama` and `email` are accepted only to be dropped (FR-03): the client may send them, the tokenizer never
 * reads them, and the outbound payload is built from the allow list instead of by deleting from this object.
 */
export const transactionBody = z.strictObject({
  source_account: z.string().regex(ACCOUNT_NUMBER),
  merchant_id: z.string().regex(MERCHANT_ID),
  amount,
  geohash: z.string().regex(GEOHASH),
  nik: z.string().max(64).optional(),
  nama: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
});
export type TransactionBody = z.output<typeof transactionBody>;

/**
 * N-27: the largest report that always fits the 64 KiB body limit of the route. An item is at most about 120 bytes
 * of JSON (20-digit account, 16-digit amount, 32-character reference), so 500 items are at most about 60 KB.
 */
export const MAX_SETTLEMENT_ITEMS = 500;

/** Settlement: the whole report is checked before a single token is asked for (FR-32, TF-13). */
export const settlementBody = z.strictObject({
  batch_date: z.string().regex(ISO_DATE).refine(isRealDate),
  items: z
    .array(
      z.strictObject({
        account_number: z.string().regex(ACCOUNT_NUMBER),
        amount,
        bank_reference: z.string().regex(BANK_REFERENCE),
      }),
    )
    .min(1)
    .max(MAX_SETTLEMENT_ITEMS),
});
export type SettlementBody = z.output<typeof settlementBody>;

/** One shape of a phone for the registration (A1) and the change of it (AZ-02), so the two cannot drift apart. */
export const PHONE = /^08[0-9]{8,12}$/;

/** AZ-02: the phone a customer wants Notification to use, and nothing else (the customer is the token's). */
export const notificationBody = z.strictObject({
  phone: z.string().regex(PHONE),
  channel: z.literal('SMS'),
});
