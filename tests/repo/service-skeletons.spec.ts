import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_IDS } from '../../packages/common/src/nest';
import { SERVICE_CLIENTS } from '../../tools/dev-idp/src/registry';

const root = join(__dirname, '..', '..');

describe.each(SERVICE_IDS)('M0-06 %s is only the shared bootstrap', (id) => {
  it('M0-06 main.ts does nothing but call runService with its own name (no duplicated skeleton)', () => {
    const main = readFileSync(join(root, 'services', id, 'src', 'main.ts'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    // The gateway adds its own module (routes, rate limit, keys); every other service is the bare bootstrap.
    expect(main).toBe(
      id === 'gateway'
        ? "import { runService } from '@privpay/common/nest';\nimport { gatewayModules } from './gateway.module';\n\nvoid runService({ service: 'gateway', modules: gatewayModules() });\n"
        : `import { runService } from '@privpay/common/nest';\n\nvoid runService({ service: '${id}' });\n`,
    );
  });

  it('M0-06 the package depends on @privpay/common, and only the gateway on more', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'services', id, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe(`@privpay/${id}`);
    expect(pkg.dependencies['@privpay/common']).toBe('workspace:*');
    if (id !== 'gateway') expect(Object.keys(pkg.dependencies)).toEqual(['@privpay/common']);
  });
});

describe.each(SERVICE_IDS)('N-04 %s is built with tsc and started with node dist/main.js', (id) => {
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(join(root, 'services', id, file), 'utf8'));

  it('N-04 its build config emits src to dist and builds @privpay/common first', () => {
    expect(read('tsconfig.build.json')).toEqual({
      extends: '../../tsconfig.build-base.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
      include: ['src'],
      references: [{ path: '../../packages/common/tsconfig.build.json' }],
    });
  });

  it('N-04 the start script runs the built main.js and nothing else', () => {
    expect((read('package.json') as { scripts: unknown }).scripts).toEqual({
      start: 'node dist/main.js',
    });
  });
});

describe('N-04 the root build covers every service and the shared package', () => {
  it('N-04 tsconfig.build.json references @privpay/common, dev-idp and each service, and customConditions stay out of builds', () => {
    const build = JSON.parse(readFileSync(join(root, 'tsconfig.build.json'), 'utf8')) as {
      references: { path: string }[];
    };
    expect(build.references.map((r) => r.path).sort()).toEqual(
      ['packages/common', 'tools/dev-idp', ...SERVICE_IDS.map((id) => `services/${id}`)]
        .map((p) => `${p}/tsconfig.build.json`)
        .sort(),
    );
    // A build resolves workspace packages through their built output; only the root typecheck reads source.
    expect(readFileSync(join(root, 'tsconfig.build-base.json'), 'utf8')).not.toContain(
      'customConditions',
    );
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toContain('customConditions');
  });

  it('N-04 @privpay/common exposes source to tests and typecheck and built output to node', () => {
    const exportsMap = (
      JSON.parse(readFileSync(join(root, 'packages', 'common', 'package.json'), 'utf8')) as {
        exports: Record<string, { source: string; default: string }>;
      }
    ).exports;
    for (const entry of Object.values(exportsMap)) {
      expect(entry.source).toMatch(/^\.\/src\/.+\.ts$/);
      expect(entry.default).toMatch(/^\.\/dist\/.+\.js$/);
    }
    expect(Object.keys(exportsMap).sort()).toEqual(['.', './nest', './testing']);
  });
});

describe('M0-06 the service list matches the repository', () => {
  it('M0-06 the services that have a main.ts are exactly the known service ids', () => {
    const withMain = readdirSync(join(root, 'services'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(root, 'services', name, 'src', 'main.ts')));
    // The dev IdP ('auth') is not a platform service and gets no bootstrap from this skeleton.
    expect(withMain.sort()).toEqual([...SERVICE_IDS].sort());
  });
});

describe('N-04 the dev IdP is built and started like the services', () => {
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(join(root, 'tools', 'dev-idp', file), 'utf8'));

  it('N-04 its build config emits src to dist and builds @privpay/common first', () => {
    expect(read('tsconfig.build.json')).toEqual({
      extends: '../../tsconfig.build-base.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
      include: ['src'],
      references: [{ path: '../../packages/common/tsconfig.build.json' }],
    });
  });

  it('N-04 main.ts is the shared bootstrap with the dev-idp module factory', () => {
    const main = readFileSync(join(root, 'tools', 'dev-idp', 'src', 'main.ts'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    expect(main).toBe(
      "import { runService } from '@privpay/common/nest';\nimport { devIdpModules } from './http';\n\nvoid runService({ service: 'dev-idp', modules: devIdpModules });\n",
    );
  });

  it('M1-01 the make-secrets script lists exactly the service accounts of the registry', () => {
    const script = readFileSync(
      join(root, 'tools', 'dev-idp', 'scripts', 'make-secrets.mjs'),
      'utf8',
    );
    const listed = /const CLIENTS = \[(.*?)\];/.exec(script)?.[1] ?? '';
    const names = [...listed.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...SERVICE_CLIENTS].sort());
  });
});
