import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Ticket M2-04: "tidak ada jalur menulis audit selain AuditWriter". A cheap guard like S-32: it reads the source, so
// it does not catch SQL assembled at run time; review and the database grants cover the rest.
const src = join(__dirname, '..', 'src');
const WRITER = join('audit', 'audit-writer.ts');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('M2-04 TK-10 audit_log is inserted into from one place', () => {
  it('M2-04 TK-10 only audit/audit-writer.ts mentions INSERT INTO audit_log', () => {
    const writers = sources(src)
      .filter((file) => /insert\s+into\s+audit_log/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file));
    expect(writers).toEqual([WRITER]);
  });
});
