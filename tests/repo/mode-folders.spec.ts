import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ADR-0006 butir 4, spec data 9: the domain code of a service is one for both modes, so it must not import the folder of
// a mode (`proposed/`, `baseline/`) or a migration, and it must not branch on the mode. Only the composition root
// (`*.module.ts`, `main.ts`) and the folders of the modes themselves may know the modes. A source reader, no dependency.
const ROOT = join(__dirname, '..', '..');
const SERVICES = ['transaction', 'fraud', 'notification', 'reconciliation', 'gateway'].map(
  (name) => `${name}-service`,
);
const MODE_FOLDERS = ['proposed', 'baseline'];

const IMPORT_PATH = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const MODE_WORDS = /PRIVACY_MODE|['"]baseline['"]|['"]proposed['"]/;

export interface Violation {
  readonly file: string;
  readonly rule: string;
}

const segmentsOf = (path: string): string[] => path.split('/').filter((part) => part !== '');
const isModeImport = (path: string): boolean =>
  segmentsOf(path).some((part) => MODE_FOLDERS.includes(part) || part === 'migrations');

/** `file` is relative to the `src` folder of its service, with `/` as separator. */
export function violationsOf(file: string, source: string): Violation[] {
  const folder = segmentsOf(file)[0] ?? '';
  const inMode = MODE_FOLDERS.includes(folder);
  const root = /(^|\/)[^/]*\.module\.ts$|^main\.ts$/.test(file);
  const found: Violation[] = [];
  for (const match of source.matchAll(IMPORT_PATH)) {
    const path = match[1] ?? '';
    if (inMode) {
      const other = MODE_FOLDERS.find((candidate) => candidate !== folder);
      if (other !== undefined && segmentsOf(path).includes(other)) {
        found.push({ file, rule: `a mode folder imports the other mode (${path})` });
      }
    } else if (!root && isModeImport(path)) {
      found.push({ file, rule: `domain code imports ${path}` });
    }
  }
  if (!inMode && !root && MODE_WORDS.test(source)) {
    found.push({ file, rule: 'domain code names the mode' });
  }
  return found;
}

function sourcesOf(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourcesOf(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('M5-01 ADR-0006 the scan can fail', () => {
  it('M5-01 ADR-0006 domain code that imports a mode folder, a migration or the mode itself is reported', () => {
    expect(
      violationsOf('transaction/repository.ts', "import { x } from '../baseline/subject-sql';"),
    ).toHaveLength(1);
    expect(violationsOf('risk/engine.ts', "const m = await import('../proposed');")).toHaveLength(
      1,
    );
    expect(violationsOf('risk/engine.ts', "import sql from '../../migrations/x';")).toHaveLength(1);
    expect(
      violationsOf('risk/engine.ts', "if (process.env.PRIVACY_MODE === 'baseline') {}"),
    ).toHaveLength(1);
  });

  it('M5-01 ADR-0006 a mode folder may not use the other mode, and the composition root may use both', () => {
    expect(violationsOf('baseline/index.ts', "import { x } from '../proposed';")).toHaveLength(1);
    expect(
      violationsOf('baseline/index.ts', "import { x } from '../transaction/repository';"),
    ).toEqual([]);
    expect(violationsOf('transaction.module.ts', "import { x } from './baseline';")).toEqual([]);
    expect(violationsOf('main.ts', "import { x } from './proposed';")).toEqual([]);
  });
});

describe.each(SERVICES)('M5-01 ADR-0006 FR-23 %s', (service) => {
  const src = join(ROOT, 'services', service, 'src');
  const files = sourcesOf(src).map((path) => ({
    name: relative(src, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));

  it('M5-01 ADR-0006 the domain code imports no folder of a mode and names no mode', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => violationsOf(file.name, file.source))).toEqual([]);
  });

  it('M5-01 ADR-0006 both modes have a folder, and each exports its adapter', () => {
    const names = files.map((file) => file.name);
    for (const mode of MODE_FOLDERS) expect(names).toContain(`${mode}/index.ts`);
  });
});
