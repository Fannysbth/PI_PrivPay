import { AuditEntryError, AuditWriter, type AuditEntry } from '../src/audit';

// Seam: AuditWriter.record, the only way a row reaches audit_log. FR-15 and spec privacy 9.2: the free-text fields of a
// row have a fixed format, so a value (an e-mail, a name, a NIK) cannot be written into them; a bad entry is refused
// before any SQL is sent. Every value below is invented.
const base: AuditEntry = {
  action: 'GENERATE_TOKEN',
  status: 'SUCCESS',
  reason: 'OK',
  requestingService: 'API_GATEWAY',
};

function stub(): { query: jest.Mock } {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

const VALID: [keyof AuditEntry, string][] = [
  ['pseudonym', 'PSEU-0A1B2C3D'],
  ['transactionId', 'TX-1700000000001'],
  ['purpose', 'PAYMENT_PROCESSING'],
  ['actorId', 'auditor-a'],
  ['actorId', 'SYSTEM'],
  ['actorId', '3f2b9c1e-6d1a-4e55-9a40-0c1d8e7a2b11'],
];

const INVALID: [keyof AuditEntry, string][] = [
  ['pseudonym', 'PSEU-0a1b2c3d'],
  ['pseudonym', 'PSEU-0A1B2C3D '],
  ['pseudonym', 'CUST-000101'],
  ['pseudonym', 'PSEU-0A1B2C3D\nPSEU-0A1B2C3E'],
  ['transactionId', 'TX-'],
  ['transactionId', 'TX-12 34'],
  ['transactionId', `TX-${'1'.repeat(30)}`],
  ['purpose', 'payment_processing'],
  ['purpose', 'PAYMENT PROCESSING'],
  ['purpose', 'P'.repeat(49)],
  ['actorId', 'budi.example@example.test'],
  ['actorId', 'Budi Santoso'],
  ['actorId', '0000000000000001'],
  ['actorId', ''],
  ['actorId', 'a'.repeat(65)],
];

describe('M2-04 FR-15 the free-text fields of an audit row have a fixed format', () => {
  it.each(VALID)('M2-04 FR-15 accepts %s = %s', async (field, value) => {
    const tx = stub();
    await new AuditWriter().record({ ...base, [field]: value }, tx);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });

  it.each(INVALID)('M2-04 FR-15 refuses %s = %j before any SQL is sent', async (field, value) => {
    const tx = stub();
    await expect(new AuditWriter().record({ ...base, [field]: value }, tx)).rejects.toBeInstanceOf(
      AuditEntryError,
    );
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('M2-04 FR-15 the refusal names the field and never carries the value', async () => {
    const secret = 'budi.example@example.test';
    const error: unknown = await new AuditWriter()
      .record({ ...base, actorId: secret }, stub())
      .catch((e: unknown) => e);
    if (!(error instanceof AuditEntryError)) throw new Error('the refusal is an AuditEntryError');
    expect(error.field).toBe('actorId');
    expect(JSON.stringify([error.message, error.field, error.name])).not.toContain(secret);
    expect(String(error.stack)).not.toContain(secret);
  });
});
