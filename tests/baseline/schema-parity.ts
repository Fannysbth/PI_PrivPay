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
  /** Same column, different type or nullability. */
  readonly different: string[];
  /** Privileges of the runtime role that differ. */
  readonly grants: string[];
}

async function describeColumns(pool: ParityPool): Promise<Map<string, string>> {
  const found = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  return new Map(
    found.rows.map((row) => [
      `${String(row['table_name'])}.${String(row['column_name'])}`,
      `${String(row['data_type'])}/${String(row['is_nullable'])}`,
    ]),
  );
}

async function describeGrants(pool: ParityPool, role: string): Promise<string[]> {
  const found = await pool.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_schema = 'public' ORDER BY table_name, privilege_type`,
    [role],
  );
  return found.rows.map((row) => `${String(row['table_name'])}:${String(row['privilege_type'])}`);
}

/**
 * ADR-0006, spec data 9: the identity column replaces the pseudonym column and the rest is the same. Compares the
 * schema a mode leaves with the other's after the identity columns are renamed; what is left over is a difference
 * that should not be there.
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
  const missing = [
    ...[...renamed.keys()]
      .filter((name) => !fromBaseline.has(name))
      .map((name) => `baseline lacks ${name}`),
    ...[...fromBaseline.keys()]
      .filter((name) => !renamed.has(name))
      .map((name) => `baseline adds ${name}`),
  ];
  const different = [...renamed]
    .filter(([name, kind]) => fromBaseline.has(name) && fromBaseline.get(name) !== kind)
    .map(([name]) => name);
  const grantsProposed = await describeGrants(proposed, appRole.proposed);
  const grantsBaseline = await describeGrants(baseline, appRole.baseline);
  const grants =
    JSON.stringify(grantsProposed) === JSON.stringify(grantsBaseline)
      ? []
      : [
          ...grantsProposed.map((grant) => `proposed ${grant}`),
          ...grantsBaseline.map((grant) => `baseline ${grant}`),
        ];
  return { missing, different, grants };
}
