/** Waiting is injected, like time, so retry backoff never makes a test sleep for real. */
export interface Delay {
  wait(ms: number): Promise<void>;
}

const invalidWait = (ms: number): RangeError | undefined =>
  Number.isFinite(ms) && ms >= 0 ? undefined : new RangeError('wait must be a non-negative number');

export class RealDelay implements Delay {
  wait(ms: number): Promise<void> {
    const invalid = invalidWait(ms);
    if (invalid !== undefined) return Promise.reject(invalid);
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/** Resolves immediately and records every requested wait. */
export class FakeDelay implements Delay {
  readonly waits: number[] = [];

  wait(ms: number): Promise<void> {
    const invalid = invalidWait(ms);
    if (invalid !== undefined) return Promise.reject(invalid);
    this.waits.push(ms);
    return Promise.resolve();
  }
}
