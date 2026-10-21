/** Waiting is injected, like time, so retry backoff never makes a test sleep for real. */
export interface Delay {
  /** Resolves after `ms`, or at once when `signal` is aborted: the timer is then cleared, so it cannot keep a process alive. */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

const invalidWait = (ms: number): RangeError | undefined =>
  Number.isFinite(ms) && ms >= 0 ? undefined : new RangeError('wait must be a non-negative number');

export class RealDelay implements Delay {
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    const invalid = invalidWait(ms);
    if (invalid !== undefined) return Promise.reject(invalid);
    if (signal?.aborted === true) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** Resolves immediately and records every requested wait. */
export class FakeDelay implements Delay {
  readonly waits: number[] = [];

  wait(ms: number, _signal?: AbortSignal): Promise<void> {
    const invalid = invalidWait(ms);
    if (invalid !== undefined) return Promise.reject(invalid);
    this.waits.push(ms);
    return Promise.resolve();
  }
}
