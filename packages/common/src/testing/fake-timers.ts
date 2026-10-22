import type { Timers } from '../scheduler';

/**
 * The timer of the scheduler for a test (M4-10): it only goes off when the test says so, so nothing waits for real time
 * and no real timer is left running. Time itself is the FakeClock the service was given.
 */
export class FakeTimers implements Timers {
  /** The timer that is armed now, if any: when it was asked to go off (`ms`) and what it runs. */
  armed: { fn: () => void; ms: number } | undefined;
  /** How many times a timer was armed. */
  arms = 0;

  set(fn: () => void, ms: number): unknown {
    this.arms += 1;
    const handle = { fn, ms };
    this.armed = handle;
    return handle;
  }

  clear(handle: unknown): void {
    if (this.armed === handle) this.armed = undefined;
  }

  /** The timer going off: the callback runs once and the timer is no longer armed. */
  fire(): void {
    const armed = this.armed;
    this.armed = undefined;
    armed?.fn();
  }
}
