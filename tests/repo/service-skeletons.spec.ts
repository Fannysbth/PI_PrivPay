import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_IDS } from '../../packages/common/src/nest';

const root = join(__dirname, '..', '..');

describe.each(SERVICE_IDS)('M0-06 %s is only the shared bootstrap', (id) => {
  it('M0-06 main.ts does nothing but call runService with its own name (no duplicated skeleton)', () => {
    const main = readFileSync(join(root, 'services', id, 'src', 'main.ts'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    expect(main).toBe(
      `import { runService } from '@privpay/common/nest';\n\nvoid runService({ service: '${id}' });\n`,
    );
  });

  it('M0-06 the package depends on @privpay/common and on nothing else', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'services', id, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe(`@privpay/${id}`);
    expect(pkg.dependencies).toEqual({ '@privpay/common': 'workspace:*' });
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
