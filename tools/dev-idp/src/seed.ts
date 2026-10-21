import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROLES } from './registry';

/** `users.dev.json` sits next to src/ and dist/, so the same path works from the sources and from the build. */
export const SEED_FILE = join(__dirname, '..', 'users.dev.json');

const CUSTOMER_ID = /^CUST-[0-9]{6}$/;
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

const userSchema = z
  .strictObject({
    id: z.string().regex(/^usr-[a-z0-9-]{1,40}$/),
    username: z.string().regex(USERNAME),
    // One role per human, as a single value: a list could hold two (ADR-0007 item 8).
    role: z.enum(ROLES),
    customer_id: z.string().regex(CUSTOMER_ID).optional(),
  })
  .refine((user) => (user.role === 'customer') === (user.customer_id !== undefined));

export type SeedUser = z.output<typeof userSchema>;

/** Reads and checks the fictitious accounts. Errors say what rule broke, never what the file contained. */
export function loadSeedUsers(file: string): SeedUser[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('seed file cannot be read as JSON');
  }
  const parsed = z.array(userSchema).safeParse(raw);
  if (!parsed.success) throw new Error('seed file does not follow the user schema');
  const users = parsed.data;
  const unique = (values: (string | undefined)[]): boolean => {
    const present = values.filter((value) => value !== undefined);
    return new Set(present).size === present.length;
  };
  if (
    !unique(users.map((u) => u.id)) ||
    !unique(users.map((u) => u.username)) ||
    !unique(users.map((u) => u.customer_id))
  ) {
    throw new Error('seed file repeats an id, username or customer_id');
  }
  return users;
}
