import { createLogger, type LogFields } from '../src/logger';
import { capture, lastEntry } from './log-capture';

// Pseudonym-shaped value built at run time, so no token-shaped literal is committed under packages/.
const fakeToken = (n: number): string => `PSEU-${n.toString(16).toUpperCase().padStart(8, '0')}`;

const CANARY_NIK = '9999123456789012';
const CANARY_PHONE = '08999123456';
const CANARY_NAME = 'Kenari Uji 0001';

describe('M0-02 the logger can only emit tokens, ids, and operational fields (NFR-15, NFR-16)', () => {
  it('M0-02 emits one JSON line with an ISO UTC time, the service and the event', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'privacy-service', destination });
    logger.info('token.issued', {
      request_id: '3f2b9c1e-6d1a-4e55-9a40-0c1d8e7a2b11',
      transaction_id: 'TX-10001',
      token: fakeToken(1),
      status: 200,
      latency_ms: 12,
    });
    const entry = lastEntry(lines);
    expect(entry).toMatchObject({
      service: 'privacy-service',
      event: 'token.issued',
      request_id: '3f2b9c1e-6d1a-4e55-9a40-0c1d8e7a2b11',
      transaction_id: 'TX-10001',
      token: fakeToken(1),
      status: 200,
      latency_ms: 12,
    });
    expect(String(entry.time)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('M0-02 drops fields outside the allowed set and never emits their values', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'transaction-service', destination });
    // A caller that bypasses the compile-time type (cast) still cannot log identity data.
    const smuggled = {
      nik: CANARY_NIK,
      phone: CANARY_PHONE,
      nama: CANARY_NAME,
      authorization: 'Bearer canary-jwt',
      transaction_id: 'TX-10001',
    } as unknown as LogFields;
    logger.info('transaction.created', smuggled);
    const output = lines.join('');
    for (const canary of [CANARY_NIK, CANARY_PHONE, CANARY_NAME, 'canary-jwt']) {
      expect(output).not.toContain(canary);
    }
    expect(lastEntry(lines)).toMatchObject({
      transaction_id: 'TX-10001',
      dropped_fields: ['nik', 'phone', 'nama', 'authorization'],
    });
  });

  it('M0-02 refuses to log identity data smuggled into an allowed field', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'fraud-service', destination });
    logger.warn('fraud.assessed', {
      token: CANARY_NIK,
      transaction_id: CANARY_PHONE,
      request_id: CANARY_NAME,
    });
    const output = lines.join('');
    for (const canary of [CANARY_NIK, CANARY_PHONE, CANARY_NAME]) {
      expect(output).not.toContain(canary);
    }
    expect(lastEntry(lines)).toMatchObject({
      token: '[INVALID]',
      transaction_id: '[INVALID]',
      request_id: '[INVALID]',
    });
  });

  it('M0-02 respects the configured level', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'gateway', level: 'warn', destination });
    logger.info('ignored');
    logger.warn('kept');
    expect(lines).toHaveLength(1);
    expect(lastEntry(lines).event).toBe('kept');
  });
});
