import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_CLIENTS } from '../src/registry';

const script = join(__dirname, '..', 'scripts', 'make-secrets.mjs');

describe('M1-01 the script that makes the dev client secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privpay-make-secrets-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (): { status: number | null; output: string } => {
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: process.env['PATH'] ?? '', DEV_IDP_SECRETS_DIR: dir },
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it('M1-01 creates one file per service account with a long random value and prints names only', () => {
    const { status, output } = run();
    expect(status).toBe(0);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(SERVICE_CLIENTS.map((client) => `${client}_client_secret`).sort());
    const values = files.map((file) => readFileSync(join(dir, file), 'utf8').trim());
    for (const value of values) {
      expect(value.length).toBeGreaterThanOrEqual(43);
      expect(output).not.toContain(value);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('M1-01 never overwrites a secret that already exists', () => {
    const file = join(dir, 'fraud_client_secret');
    writeFileSync(file, 'existing-fake-secret-value-0123456789\n');
    const before = readFileSync(file, 'utf8');
    expect(run().status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
