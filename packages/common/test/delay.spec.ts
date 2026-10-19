import { FakeDelay, RealDelay } from '../src/delay';

describe('M0-03 delays are injectable so tests never sleep for real', () => {
  it('M0-03 FakeDelay resolves immediately and records what was asked', async () => {
    const delay = new FakeDelay();
    await delay.wait(100);
    await delay.wait(250);
    expect(delay.waits).toEqual([100, 250]);
  });

  it('M0-03 RealDelay resolves after the requested time', async () => {
    const started = Date.now();
    await new RealDelay().wait(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });

  it('M0-03 delays refuse negative or non-finite waits', async () => {
    await expect(new RealDelay().wait(-1)).rejects.toThrow(RangeError);
    await expect(new FakeDelay().wait(Number.NaN)).rejects.toThrow(RangeError);
  });
});
