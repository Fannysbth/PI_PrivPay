import { runService } from '../src/nest';

describe('M0-06 runService stops the process when the environment is wrong (fail fast)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  it('M0-06 a missing PRIVACY_MODE sets exit code 1 and prints the variable name only', async () => {
    delete process.env['PRIVACY_MODE'];
    process.env['PORT'] = '0';
    process.env['SOME_SECRET_LOOKING_VALUE'] = 'fake-value-do-not-print';
    const written: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await runService({ service: 'fraud-service' });

    expect(process.exitCode).toBe(1);
    const text = written.join('');
    expect(text).toContain('fraud-service');
    expect(text).toContain('PRIVACY_MODE (missing)');
    expect(text).not.toContain('fake-value-do-not-print');
  });

  it('M0-06 forces TZ to UTC before anything reads a date (NFR-20)', async () => {
    delete process.env['PRIVACY_MODE'];
    process.env['TZ'] = 'Asia/Jakarta';
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runService({ service: 'gateway' });
    // The refusal of a non-UTC TZ comes from the schema; runService overwrites it first, so the start only fails on the mode.
    expect(process.env['TZ']).toBe('UTC');
  });
});
