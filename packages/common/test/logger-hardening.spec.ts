import { createLogger, type LogFields } from '../src/logger';
import { capture, lastEntry } from './log-capture';

const CANARY_NIK = '9999123456789012';
const CANARY_PHONE = '08999123456';
const CANARY_NAME = 'Kenari Uji 0001';

describe('M0-02 the logger cannot be tricked through odd keys or loose values (NFR-15)', () => {
  it('M0-02 drops keys every object has, such as constructor and toString, and survives __proto__', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'gateway', destination });
    const hostile = JSON.parse(
      `{"constructor":"NIK ${CANARY_NIK}","toString":"${CANARY_NAME}","__proto__":"${CANARY_PHONE}","status":200}`,
    ) as LogFields;
    expect(() => {
      logger.info('request.finished', hostile);
    }).not.toThrow();
    const output = lines.join('');
    for (const canary of [CANARY_NIK, CANARY_NAME, CANARY_PHONE]) {
      expect(output).not.toContain(canary);
    }
    expect(lastEntry(lines)).toMatchObject({ status: 200 });
  });

  it('M0-02 does not let a call override the service name', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'gateway', destination });
    logger.info('request.finished', { service: 'other' } as unknown as LogFields);
    expect(lines.join('')).not.toContain('other');
    expect(lastEntry(lines)).toMatchObject({ service: 'gateway', dropped_fields: ['service'] });
  });

  it.each(['email', 'rekening', 'customer_id', 'subject_id', 'x-actor-token', 'password'])(
    'M0-02 never emits the value of a forbidden field named %s',
    (name) => {
      const { lines, destination } = capture();
      // A computed key is typed as a string index, which the compiler accepts; only the run-time guard stops it.
      createLogger({ service: 'gateway', destination }).info('request.finished', {
        [name]: CANARY_NAME,
      });
      expect(lines.join('')).not.toContain(CANARY_NAME);
    },
  );

  it('M0-02 does not compile when a forbidden field is passed (enforced by pnpm typecheck)', () => {
    const { destination } = capture();
    const logger = createLogger({ service: 'gateway', destination });
    // @ts-expect-error nik is not an allowed log field
    logger.info('request.finished', { nik: CANARY_NIK });
  });

  it('M0-02 does not echo identifier-like key names in dropped_fields', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'gateway', destination });
    logger.info('request.finished', { [CANARY_NIK]: 'x' } as unknown as LogFields);
    expect(lines.join('')).not.toContain(CANARY_NIK);
    expect(lastEntry(lines)).toMatchObject({ dropped_fields: ['[invalid_key]'] });
  });

  it('M0-02 refuses implausible latency values and unknown reasons', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'gateway', destination });
    logger.info('request.finished', { latency_ms: 3201010101010001, reason: 'BUDI_SANTOSO' });
    expect(lines.join('')).not.toContain('3201010101010001');
    expect(lines.join('')).not.toContain('BUDI_SANTOSO');
    expect(lastEntry(lines)).toMatchObject({ latency_ms: '[INVALID]', reason: '[INVALID]' });
  });

  it('M0-02 accepts a known reason', () => {
    const { lines, destination } = capture();
    createLogger({ service: 'gateway', destination }).warn('request.denied', {
      reason: 'SERVICE_MISMATCH',
    });
    expect(lastEntry(lines)).toMatchObject({ reason: 'SERVICE_MISMATCH' });
  });

  it('M0-02 keeps logging when a field getter throws', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'gateway', destination });
    const trap = {
      get status(): number {
        throw new Error('boom');
      },
    } as unknown as LogFields;
    expect(() => {
      logger.info('request.finished', trap);
    }).not.toThrow();
    expect(lastEntry(lines)).toMatchObject({ event: 'request.finished' });
  });
});
