import { z } from 'zod';

/**
 * Tabel 5: the only attributes that can ever be released are these three, and only as text. Anything else in an answer
 * (a phone, an account, a field of another name, a value that is not text) means the answer is not one this service
 * may pass on, however it got there (T-14, S-27). Checked where the answer arrives and again before it leaves.
 */
export const disclosedAttributes = z.strictObject({
  customer_id: z.string().min(1).max(64).optional(),
  nik: z.string().min(1).max(64).optional(),
  nama: z.string().min(1).max(200).optional(),
});
