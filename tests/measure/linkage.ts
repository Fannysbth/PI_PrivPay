// M6-03 (Metodologi D.3, docs/spec/pengujian-dan-pengukuran.md 7): the linkage attack as arithmetic. The attacker holds copies of
// the databases of the downstream services and joins rows by EQUAL identifier values (token or real identifier). The
// subject of each row is ground truth known to the evaluator only; the attacker's join never reads it. Nothing here proves
// unlinkability: it counts what this one attack could and could not join in the data that was run.

export interface LinkRow {
  readonly service: string;
  /** Ground truth (the evaluator's), `null` when the evaluator cannot say whose the row is. */
  readonly subject: string | null;
  /** The subject-reference columns of the row: column name to value. */
  readonly refs: Readonly<Record<string, string>>;
}

export interface PairResult {
  readonly a: string;
  readonly b: string;
  readonly subjectsInBoth: number;
  readonly linked: number;
  readonly rate: number | null;
  readonly edges: number;
  readonly falseEdges: number;
}

export interface ChainResult {
  readonly subjectsInAll: number;
  readonly chained: number;
  readonly rate: number | null;
}

const valuesOf = (row: LinkRow): string[] =>
  Object.values(row.refs).filter((value) => value !== '');

const subjectsOf = (rows: readonly LinkRow[], service: string): Set<string> =>
  new Set(
    rows.flatMap((row) => (row.service === service && row.subject !== null ? [row.subject] : [])),
  );

function indexByValue(rows: readonly LinkRow[]): Map<string, LinkRow[]> {
  const index = new Map<string, LinkRow[]>();
  for (const row of rows) {
    for (const value of new Set(valuesOf(row))) {
      const list = index.get(value);
      if (list === undefined) index.set(value, [row]);
      else list.push(row);
    }
  }
  return index;
}

/** The distinct (row of a, row of b) pairs that share at least one identifier value. */
function crossEdges(rows: readonly LinkRow[], a: string, b: string): [LinkRow, LinkRow][] {
  const rowsA = rows.filter((row) => row.service === a);
  const indexB = indexByValue(rows.filter((row) => row.service === b));
  const seen = new Map<LinkRow, Set<LinkRow>>();
  const edges: [LinkRow, LinkRow][] = [];
  for (const rowA of rowsA) {
    for (const value of new Set(valuesOf(rowA))) {
      for (const rowB of indexB.get(value) ?? []) {
        const done = seen.get(rowA) ?? new Set<LinkRow>();
        seen.set(rowA, done);
        if (!done.has(rowB)) {
          done.add(rowB);
          edges.push([rowA, rowB]);
        }
      }
    }
  }
  return edges;
}

export function crossServiceLinking(
  rows: readonly LinkRow[],
  services: readonly string[],
): { pairs: PairResult[]; chain: ChainResult } {
  const pairs: PairResult[] = [];
  for (const [i, a] of services.entries()) {
    for (const b of services.slice(i + 1)) {
      const edges = crossEdges(rows, a, b);
      const bothSides = [...subjectsOf(rows, a)].filter((subject) =>
        subjectsOf(rows, b).has(subject),
      );
      const trueEdges = edges.filter(([x, y]) => x.subject !== null && x.subject === y.subject);
      const linked = new Set(trueEdges.map(([x]) => x.subject)).size;
      pairs.push({
        a,
        b,
        subjectsInBoth: bothSides.length,
        linked,
        rate: bothSides.length === 0 ? null : linked / bothSides.length,
        edges: edges.length,
        falseEdges: edges.length - trueEdges.length,
      });
    }
  }
  return { pairs, chain: chainOf(rows, services) };
}

/** Colluding services: rows that join across services are one component; a subject is chained when one component holds a row of
 * its own from every service. */
function chainOf(rows: readonly LinkRow[], services: readonly string[]): ChainResult {
  const parent = new Map<LinkRow, LinkRow>();
  const find = (row: LinkRow): LinkRow => {
    let root = parent.get(row) ?? row;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(row, root);
    return root;
  };
  for (const [i, a] of services.entries()) {
    for (const b of services.slice(i + 1)) {
      for (const [x, y] of crossEdges(rows, a, b)) parent.set(find(x), find(y));
    }
  }
  const everyone = services.map((service) => subjectsOf(rows, service));
  const inAll = [...(everyone[0] ?? [])].filter((subject) =>
    everyone.every((set) => set.has(subject)),
  );
  let chained = 0;
  for (const subject of inAll) {
    const own = rows.filter((row) => row.subject === subject);
    const components = new Map<LinkRow, Set<string>>();
    for (const row of own) {
      const root = find(row);
      components.set(root, (components.get(root) ?? new Set<string>()).add(row.service));
    }
    if ([...components.values()].some((covered) => services.every((s) => covered.has(s))))
      chained += 1;
  }
  return {
    subjectsInAll: inAll.length,
    chained,
    rate: inAll.length === 0 ? null : chained / inAll.length,
  };
}

export interface GroupingResult {
  readonly service: string;
  readonly truePairs: number;
  readonly groupedPairs: number;
  readonly groupedTruePairs: number;
  readonly recall: number | null;
  readonly precision: number | null;
}

/** Linkability inside one service: do two rows of the same subject carry the same identifier value? (token reuse, S-71/S-72) */
export function withinServiceGrouping(rows: readonly LinkRow[], service: string): GroupingResult {
  const own = rows.filter((row) => row.service === service && row.subject !== null);
  const perSubject = new Map<string, number>();
  for (const row of own)
    perSubject.set(row.subject ?? '', (perSubject.get(row.subject ?? '') ?? 0) + 1);
  const truePairs = [...perSubject.values()].reduce((sum, n) => sum + (n * (n - 1)) / 2, 0);
  const pairs = new Set<string>();
  const ids = new Map(own.map((row, i) => [row, i]));
  for (const group of indexByValue(own).values()) {
    for (const [i, x] of group.entries()) {
      for (const y of group.slice(i + 1)) {
        const [p, q] = [ids.get(x) ?? 0, ids.get(y) ?? 0];
        pairs.add(p < q ? `${String(p)}|${String(q)}` : `${String(q)}|${String(p)}`);
      }
    }
  }
  const same = [...pairs].filter((key) => {
    const [p, q] = key.split('|').map(Number);
    return own[p ?? 0]?.subject === own[q ?? 0]?.subject;
  }).length;
  return {
    service,
    truePairs,
    groupedPairs: pairs.size,
    groupedTruePairs: same,
    recall: truePairs === 0 ? null : same / truePairs,
    precision: pairs.size === 0 ? null : same / pairs.size,
  };
}
