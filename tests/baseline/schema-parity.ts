/** The part of a `pg` pool this needs, so the helper has no dependency of its own (tests/ is not a package). */
export interface ParityPool {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, string | number | null>[] }>;
}

/** Proposed `table.column` to baseline `table.column`: the columns that carry the subject (spec data 9). */
export type IdentityColumns = Readonly<Record<string, string>>;

export interface ParityReport {
  /** Columns present in one mode and absent in the other, once the identity columns are renamed. */
  readonly missing: string[];
  /** Same column, different type, length or nullability (the length of an identity column may differ). */
  readonly different: string[];
  /** Indexes (by name) present in one mode and not in the other. */
  readonly indexes: string[];
  /** Privileges of the runtime role that differ. */
  readonly grants: string[];
}

interface ColumnKind {
  readonly kind: string;
  readonly length: string;
}

async function describeColumns(pool: ParityPool): Promise<Map<string, ColumnKind>> {
  const found = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  return new Map(
    found.rows.map((row) => [
      `${String(row['table_name'])}.${String(row['column_name'])}`,
      {
        kind: `${String(row['data_type'])}/${String(row['is_nullable'])}`,
        length: String(row['character_maximum_length']),
      },
    ]),
  );
}

async function describeIndexes(pool: ParityPool): Promise<string[]> {
  const found = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
  );
  return found.rows.map((row) => String(row['indexname']));
}

async function describeGrants(pool: ParityPool, role: string): Promise<string[]> {
  const found = await pool.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_schema = 'public' ORDER BY table_name, privilege_type`,
    [role],
  );
  return found.rows.map((row) => `${String(row['table_name'])}:${String(row['privilege_type'])}`);
}

const onlyIn = (label: string, mine: readonly string[], theirs: readonly string[]): string[] =>
  mine.filter((name) => !theirs.includes(name)).map((name) => `${label} ${name}`);

/**
 * ADR-0006, spec data 9: the identity column replaces the pseudonym column and the rest is the same. Compares the
 * schema a mode leaves with the other's after the identity columns are renamed: columns, types, lengths, nullability,
 * index names and the privileges of the runtime role. What is left over is a difference that should not be there.
 */
export async function compareSchemas(
  proposed: ParityPool,
  baseline: ParityPool,
  identity: IdentityColumns,
  appRole: { proposed: string; baseline: string },
): Promise<ParityReport> {
  const fromProposed = await describeColumns(proposed);
  const fromBaseline = await describeColumns(baseline);
  const renamed = new Map(
    [...fromProposed].map(([name, kind]) => [identity[name] ?? name, kind] as const),
  );
  const namesProposed = [...renamed.keys()];
  const namesBaseline = [...fromBaseline.keys()];
  const identityNames = new Set(Object.values(identity));
  const different = [...renamed]
    .filter(([name, kind]) => {
      const other = fromBaseline.get(name);
      if (other === undefined) return false;
      return identityNames.has(name)
        ? other.kind !== kind.kind
        : other.kind !== kind.kind || other.length !== kind.length;
    })
    .map(([name]) => name);
  const indexesProposed = await describeIndexes(proposed);
  const indexesBaseline = await describeIndexes(baseline);
  const grantsProposed = await describeGrants(proposed, appRole.proposed);
  const grantsBaseline = await describeGrants(baseline, appRole.baseline);
  return {
    missing: [
      ...onlyIn('baseline lacks', namesProposed, namesBaseline),
      ...onlyIn('baseline adds', namesBaseline, namesProposed),
    ],
    different,
    indexes: [
      ...onlyIn('baseline lacks', indexesProposed, indexesBaseline),
      ...onlyIn('baseline adds', indexesBaseline, indexesProposed),
    ],
    grants: [
      ...onlyIn('baseline lacks', grantsProposed, grantsBaseline),
      ...onlyIn('baseline adds', grantsBaseline, grantsProposed),
    ],
  };
}
