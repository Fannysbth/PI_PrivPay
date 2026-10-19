export interface Capture {
  readonly lines: string[];
  readonly destination: { write(line: string): void };
}

/** A log destination that keeps every emitted line in memory. */
export function capture(): Capture {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
  };
}

export function lastEntry(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
}
