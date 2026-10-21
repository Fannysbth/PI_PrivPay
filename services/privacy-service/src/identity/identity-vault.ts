import { randomUUID } from 'node:crypto';
import { DomainError, type Clock } from '@privpay/common';
import { DeniedOperation, type AuditedOperation } from '../audit';
import { vaultBinding, type BlindIndex, type FieldCipher } from '../crypto';

/** Spec privacy 4.9: the formats of platform-dan-ci.md 3.1 (`CustomerId`, `Nik`, `Phone`, `AccountNumber`) and the name. */
const CUSTOMER_ID = /^CUST-[0-9]{6}$/;
const NIK = /^[0-9]{16}$/;
const HP = /^08[0-9]{8,12}$/;
const REKENING = /^[0-9]{8,20}$/;
const NAMA = /^[\p{L} .'-]{1,100}$/u;
const SERVICE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Spec privacy 4.9, TK-20: the only caller. Not a Tabel 3 row (it is not a token operation), so it lives here. */
const STORE_CALLER = 'API_GATEWAY';

/** The attributes the answer lists, in the order of the spec. */
const STORED = ['nik', 'nama', 'hp', 'rekening'] as const;

export interface StoreIdentityRequest {
  readonly requestingService: string;
  readonly customerId: string;
  readonly nik: string;
  readonly nama: string;
  readonly hp: string;
  readonly rekening: string;
}

export interface StoreIdentityResult {
  /** True for the first call of a customer (201), false for a repeat that replaced the ciphertexts (200). */
  readonly created: boolean;
  readonly storedAttributes: typeof STORED;
}

export interface IdentityVaultDeps {
  readonly operation: AuditedOperation;
  readonly index: Pick<BlindIndex, 'lookup'>;
  readonly cipher: Pick<FieldCipher, 'encrypt'>;
  readonly clock: Clock;
  /** The `key_version` of the written rows (PSEUDONYM_KEY_VERSION). */
  readonly keyVersion: number;
  /** UUID v4 for the row id; replaceable in a test. */
  readonly newId?: () => string;
}

export const VAULT_SQL = {
  // Spec privacy 4.9 (K-10): one customer, one row. The lock is taken on the lookup first because the AAD is bound to
  // the row id (ADR-0011): a repeat must be encrypted for the id of the row that exists, which ON CONFLICT DO UPDATE
  // alone cannot know. The lock also makes two first calls in parallel leave one row.
  lock: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  find: 'SELECT id FROM identity_vault WHERE customer_lookup = $1 FOR UPDATE',
  insert: `INSERT INTO identity_vault
       (id, customer_lookup, customer_id_enc, nik_enc, nama_enc, hp_enc, rekening_enc, key_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  update: `UPDATE identity_vault
     SET customer_id_enc = $2, nik_enc = $3, nama_enc = $4, hp_enc = $5, rekening_enc = $6, key_version = $7
     WHERE id = $1`,
} as const;

const invalid = (): DomainError => new DomainError('VALIDATION_ERROR');
const matches = (value: unknown, pattern: RegExp): void => {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
};

/**
 * Stores the identity of a registered customer, encrypted per column with an AAD bound to the row (spec privacy 4.9,
 * flow A5). The values are only ever encrypted: they are not logged, not audited, and no result or error carries them.
 */
export class IdentityVault {
  private readonly newId: () => string;

  constructor(private readonly deps: IdentityVaultDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  async store(request: StoreIdentityRequest): Promise<StoreIdentityResult> {
    // The shape first, so a malformed request is a 422 and leaves no audit row (spec privacy 9.4).
    matches(request.requestingService, SERVICE_ID);
    matches(request.customerId, CUSTOMER_ID);
    matches(request.nik, NIK);
    matches(request.nama, NAMA);
    matches(request.hp, HP);
    matches(request.rekening, REKENING);
    const { cipher, clock, keyVersion } = this.deps;
    return this.deps.operation.run(async (tx) => {
      const audit = {
        action: 'STORE_IDENTITY',
        requestingService: request.requestingService,
        keyVersion,
      } as const;
      // TK-20: refused before anything is read or written.
      if (request.requestingService !== STORE_CALLER) {
        throw new DeniedOperation({ ...audit, status: 'DENIED', reason: 'POLICY_NOT_ALLOWED' });
      }
      const lookup = this.deps.index.lookup('CUSTOMER', request.customerId);
      await tx.query(VAULT_SQL.lock, [`identity:${lookup.toString('hex')}`]);
      const found = await tx.query<{ id: string }>(VAULT_SQL.find, [lookup]);
      const existing = found.rows[0]?.id;
      const id = existing ?? this.newId();
      const seal = (column: Parameters<typeof vaultBinding>[0], value: string): Buffer =>
        cipher.encrypt(value, vaultBinding(column, id));
      const blobs = [
        seal('customer_id', request.customerId),
        seal('nik', request.nik),
        seal('nama', request.nama),
        seal('hp', request.hp),
        seal('rekening', request.rekening),
      ];
      if (existing === undefined) {
        await tx.query(VAULT_SQL.insert, [id, lookup, ...blobs, keyVersion, clock.now()]);
      } else {
        await tx.query(VAULT_SQL.update, [id, ...blobs, keyVersion]);
      }
      return {
        result: { created: existing === undefined, storedAttributes: STORED },
        audit: { ...audit, status: 'SUCCESS', reason: 'OK' },
      };
    });
  }
}
