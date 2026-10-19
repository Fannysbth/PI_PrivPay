/** Time is always injected so tests never sleep for real and every instant is UTC (NFR-20). */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** An ISO string without `Z` or an offset would be read as local time, which breaks the UTC rule. */
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

function toInstant(value: string | Date): Date {
  if (typeof value === 'string' && !HAS_ZONE.test(value)) {
    throw new RangeError('instant needs a time zone (use Z or an offset)');
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new RangeError('invalid instant');
  return instant;
}

export class FakeClock implements Clock {
  private current: Date;

  constructor(start: string | Date) {
    this.current = toInstant(start);
  }

  /** Returns a copy, so callers cannot move time by mutating the Date they received. */
  now(): Date {
    return new Date(this.current);
  }

  advance(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new RangeError('seconds must be finite');
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }

  set(to: string | Date): void {
    this.current = toInstant(to);
  }
}
