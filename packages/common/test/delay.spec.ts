import { FakeDelay, RealDelay } from '../src/delay';

describe('M0-03 delays are injectable so tests never sleep for real', () => {
  it('M0-03 FakeDelay resolves immediately and records what was asked', async () => {
    const delay = new FakeDelay();
    await delay.wait(100);
    await delay.wait(250);
    expect(delay.waits).toEqual([100, 250]);
  });

  it('M0-03 RealDelay resolves once the requested time has passed', async () => {
    jest.useFakeTimers();
    try {
      let done = false;
      const waiting = new RealDelay().wait(1000).then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('M0-03 RealDelay stops its timer when the signal is aborted, so no handle is left running', async () => {
    jest.useFakeTimers();
    try {
      const abort = new AbortController();
      const waiting = new RealDelay().wait(10_000, abort.signal);
      expect(jest.getTimerCount()).toBe(1);
      abort.abort();
      await waiting;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('M0-03 RealDelay with a signal that is already aborted starts no timer', async () => {
    jest.useFakeTimers();
    try {
      const abort = new AbortController();
      abort.abort();
      await new RealDelay().wait(10_000, abort.signal);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('M0-03 delays refuse negative or non-finite waits', async () => {
    await expect(new RealDelay().wait(-1)).rejects.toThrow(RangeError);
    await expect(new FakeDelay().wait(Number.NaN)).rejects.toThrow(RangeError);
  });
});
