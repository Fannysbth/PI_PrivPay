import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// M7-C: static tests of the CPU sensitivity override. Nothing starts Docker.
const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');
interface Svc {
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } };
}
const load = (file: string): Record<string, Svc> =>
  (parse(read('deploy', 'measure', file)) as { services: Record<string, Svc> }).services;
const common = load('compose.sensitivity.yml');
const proposedOnly = load('compose.sensitivity.proposed.yml');

describe('M7-C CPU sensitivity override (not a main result)', () => {
  it('M7-C gives every service the same CPU quota, one value for both conditions', () => {
    const quotas = new Set(
      [...Object.values(common), ...Object.values(proposedOnly)].map(
        (s) => s.deploy?.resources?.limits?.cpus,
      ),
    );
    expect([...quotas]).toEqual(['1.00']);
  });

  it('M7-C changes only the CPU quota, never memory', () => {
    for (const s of [...Object.values(common), ...Object.values(proposedOnly)])
      expect(Object.keys(s.deploy?.resources?.limits ?? {})).toEqual(['cpus']);
  });

  it('M7-C keeps the Privacy-only services out of the file both conditions can load', () => {
    expect(Object.keys(common)).not.toContain('privacy-service');
    expect(Object.keys(common)).not.toContain('pg-privacy');
    expect(Object.keys(proposedOnly).sort()).toEqual(['pg-privacy', 'privacy-service']);
  });

  it('M7-C names only services that the base Compose file or the proposed file defines', () => {
    const base = read('deploy', 'compose', 'docker-compose.yml');
    const proposed = read('deploy', 'compose', 'mode.proposed.yml');
    for (const name of Object.keys(common)) expect(base).toMatch(new RegExp(`^ {2}${name}:$`, 'm'));
    for (const name of Object.keys(proposedOnly))
      expect(proposed).toMatch(new RegExp(`^ {2}${name}:$`, 'm'));
  });

  it('M7-C is marked "not the main result" and is not read by the runner', () => {
    for (const file of ['compose.sensitivity.yml', 'compose.sensitivity.proposed.yml'])
      expect(read('deploy', 'measure', file)).toMatch(/NOT THE MAIN RESULT/);
    expect(read('scripts', 'perf', 'run.cjs')).not.toMatch(/sensitivity/i);
  });
});
