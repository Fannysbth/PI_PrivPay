import { ConfigError } from '../src/config';
import { FakeClock } from '../src/clock';
import { DomainError } from '../src/errors';
import {
  Scheduler,
  SCHEDULER,
  schedulerEnabled,
  schedulerProviders,
  type Job,
} from '../src/scheduler';
import { FakeTimers } from '../src/testing/fake-timers';

// Seam: the one scheduler of every service (M4-10, K-19, K-23, K-26). Time is a FakeClock and the timer is a fake that
// only fires when a test says so, so nothing waits for real time and nothing real is left running. Every job here is
// invented; what is logged is a job name and a reason, never a value.
const recordingLogger = () => {
  const entries: { event: string; fields: object | undefined }[] = [];
  const at = (event: string, fields?: object) => void entries.push({ event, fields });
  return { entries, logger: { debug: at, info: at, warn: at, error: at } };
};

const START = '2026-10-22T00:05:00.000Z';
let clock: FakeClock;
let timers: FakeTimers;
let log: ReturnType<typeof recordingLogger>;
beforeEach(() => {
  clock = new FakeClock(START);
  timers = new FakeTimers();
  log = recordingLogger();
});

const make = (jobs: readonly Job[]) => new Scheduler({ clock, timers, logger: log.logger, jobs });
/** A job that counts its runs and finishes at once. */
const counting = (name: string, schedule: Job['schedule']) => {
  const state = { runs: 0 };
  const job: Job = {
    name,
    schedule,
    run: () => {
      state.runs += 1;
      return Promise.resolve();
    },
  };
  return { state, job };
};
/** Lets the promises a tick started settle, without waiting for time. */
const settle = async (scheduler: Scheduler): Promise<void> => {
  timers.fire();
  await scheduler.idle();
};

describe('M4-10 K-23 K-26 a daily job runs at its time, once', () => {
  it('M4-10 K-23 it is armed for the minutes left, runs when the time comes, and is not run again that minute', async () => {
    const { state, job } = counting('daily', { kind: 'daily', runUtc: '00:10' });
    const scheduler = make([job]);
    scheduler.start();
    expect(timers.armed?.ms).toBe(5 * 60 * 1000);
    expect(state.runs).toBe(0);
    clock.set('2026-10-22T00:10:00.000Z');
    await settle(scheduler);
    expect(state.runs).toBe(1);
    // Fired again in the same minute (a timer that wakes early): the next run is tomorrow's.
    await settle(scheduler);
    expect(state.runs).toBe(1);
    clock.set('2026-10-23T00:10:00.000Z');
    await settle(scheduler);
    expect(state.runs).toBe(2);
    await scheduler.stop();
  });

  it('M4-10 K-23 a long wait is cut into wake-ups of at most an hour, so a clock that was set is noticed', async () => {
    const { job } = counting('daily', { kind: 'daily', runUtc: '23:00' });
    const scheduler = make([job]);
    scheduler.start();
    expect(timers.armed?.ms).toBe(60 * 60 * 1000);
    await scheduler.stop();
  });
});

describe('M4-10 K-19 an interval job runs every N seconds', () => {
  it('M4-10 K-19 it runs once the interval has passed, not before', async () => {
    const { state, job } = counting('sweep', { kind: 'every', seconds: 30 });
    const scheduler = make([job]);
    scheduler.start();
    expect(timers.armed?.ms).toBe(30_000);
    clock.advance(29);
    await settle(scheduler);
    expect(state.runs).toBe(0);
    clock.advance(1);
    await settle(scheduler);
    expect(state.runs).toBe(1);
    clock.advance(30);
    await settle(scheduler);
    expect(state.runs).toBe(2);
    await scheduler.stop();
  });

  it('M4-10 K-19 two jobs with their own intervals keep their own time', async () => {
    const fast = counting('fast', { kind: 'every', seconds: 10 });
    const slow = counting('slow', { kind: 'every', seconds: 60 });
    const scheduler = make([fast.job, slow.job]);
    scheduler.start();
    for (let second = 0; second < 60; second += 10) {
      clock.advance(10);
      await settle(scheduler);
    }
    expect([fast.state.runs, slow.state.runs]).toEqual([6, 1]);
    await scheduler.stop();
  });
});

describe('M4-10 a job never overlaps itself', () => {
  it('M4-10 an occurrence that comes while the job still runs is skipped, and the job runs again when it is due after it ended', async () => {
    let release: (() => void) | undefined;
    let runs = 0;
    const job: Job = {
      name: 'slow',
      schedule: { kind: 'every', seconds: 10 },
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const scheduler = make([job]);
    scheduler.start();
    clock.advance(10);
    timers.fire();
    expect(runs).toBe(1);
    // Due again while the first run is not over: not started, not queued.
    clock.advance(10);
    timers.fire();
    clock.advance(10);
    timers.fire();
    expect(runs).toBe(1);
    release?.();
    await scheduler.idle();
    clock.advance(10);
    timers.fire();
    expect(runs).toBe(2);
    release?.();
    await scheduler.stop();
  });
});

describe('M4-10 the stop waits for what runs and starts nothing more', () => {
  it('M4-10 stop is not done until the running job is, cancels the timer, and a due job does not start after it', async () => {
    let release: (() => void) | undefined;
    let finished = false;
    const job: Job = {
      name: 'long',
      schedule: { kind: 'every', seconds: 10 },
      run: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finished = true;
      },
    };
    const other = counting('other', { kind: 'every', seconds: 10 });
    const scheduler = make([job, other.job]);
    scheduler.start();
    clock.advance(10);
    timers.fire();
    expect(other.state.runs).toBe(1);
    // The callback of the timer that was armed when the stop began: it still goes off, as a timer on its way would.
    const onItsWay = timers.armed?.fn;
    const stopped = scheduler.stop();
    let done = false;
    void stopped.then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(timers.armed).toBeUndefined();
    // A timer that was already on its way (fired just as the stop began) starts nothing.
    clock.advance(10);
    onItsWay?.();
    expect(other.state.runs).toBe(1);
    release?.();
    await stopped;
    expect(finished).toBe(true);
    expect(done).toBe(true);
  });

  it('M4-10 stop is safe to call twice, before start, and after a start that came late', async () => {
    const { state, job } = counting('daily', { kind: 'every', seconds: 5 });
    const scheduler = make([job]);
    await scheduler.stop();
    scheduler.start();
    expect(timers.armed).toBeUndefined();
    await scheduler.stop();
    expect(state.runs).toBe(0);
    const again = make([job]);
    again.start();
    again.start();
    expect(timers.arms).toBe(1);
    await again.stop();
    await again.stop();
  });
});

describe('M4-10 an error in a job is caught and the process goes on', () => {
  it('M4-10 a refused job is logged by name and reason only, the other jobs run, and the next occurrence runs again', async () => {
    let calls = 0;
    const failing: Job = {
      name: 'privacy-away',
      schedule: { kind: 'every', seconds: 10 },
      run: () => {
        calls += 1;
        return Promise.reject(new DomainError('SERVICE_UNAVAILABLE', 'a cause'));
      },
    };
    const healthy = counting('healthy', { kind: 'every', seconds: 10 });
    const scheduler = make([failing, healthy.job]);
    scheduler.start();
    clock.advance(10);
    await settle(scheduler);
    clock.advance(10);
    await settle(scheduler);
    expect(calls).toBe(2);
    expect(healthy.state.runs).toBe(2);
    expect(log.entries).toEqual([
      { event: 'job_failed_privacy-away', fields: { reason: 'SERVICE_UNAVAILABLE' } },
      { event: 'job_failed_privacy-away', fields: { reason: 'SERVICE_UNAVAILABLE' } },
    ]);
    await scheduler.stop();
  });

  it('M4-10 an error that is not ours is INTERNAL_ERROR, and its message (which may hold a value) is never logged', async () => {
    const leaky: Job = {
      name: 'leaky',
      schedule: { kind: 'every', seconds: 10 },
      run: () => Promise.reject(new Error('could not update row of nasabah 081200000099')),
    };
    const scheduler = make([leaky]);
    scheduler.start();
    clock.advance(10);
    await settle(scheduler);
    expect(log.entries).toEqual([
      { event: 'job_failed_leaky', fields: { reason: 'INTERNAL_ERROR' } },
    ]);
    expect(JSON.stringify(log.entries)).not.toContain('081200000099');
    await scheduler.stop();
  });

  it('M4-10 a job that throws before it returns a promise is caught too', async () => {
    const sync: Job = {
      name: 'sync',
      schedule: { kind: 'every', seconds: 10 },
      run: () => {
        throw new TypeError('boom');
      },
    };
    const scheduler = make([sync]);
    scheduler.start();
    clock.advance(10);
    await settle(scheduler);
    expect(log.entries).toHaveLength(1);
    await scheduler.stop();
  });
});

describe('M4-10 a schedule that cannot work stops the start', () => {
  it.each([
    ['an interval of 0', { kind: 'every', seconds: 0 }],
    ['a negative interval', { kind: 'every', seconds: -5 }],
    ['an interval with a fraction', { kind: 'every', seconds: 1.5 }],
    ['an interval that is not a number', { kind: 'every', seconds: Number.NaN }],
    ['a time of day without minutes', { kind: 'daily', runUtc: '7' }],
    ['a time of day out of range', { kind: 'daily', runUtc: '24:00' }],
  ] as const)('M4-10 %s is refused when the scheduler is made', (_label, schedule) => {
    const { job } = counting('bad', schedule);
    expect(() => make([job])).toThrow(RangeError);
  });

  it('M4-10 two jobs with one name are refused: the log would not tell them apart', () => {
    const a = counting('same', { kind: 'every', seconds: 5 }).job;
    expect(() => make([a, a])).toThrow(RangeError);
  });
});

describe('M4-10 the scheduler is off in a test unless it is asked for', () => {
  it.each([
    [{ NODE_ENV: 'test' }, false],
    [{ NODE_ENV: 'test', SCHEDULER_ENABLED: 'true' }, true],
    [{ NODE_ENV: 'production' }, true],
    [{}, true],
    [{ NODE_ENV: 'production', SCHEDULER_ENABLED: 'false' }, false],
    [{ NODE_ENV: ' Test ' }, false],
  ])('M4-10 the environment %j gives %s', (env, expected) => {
    expect(schedulerEnabled(env)).toBe(expected);
  });

  it.each(['TRUE', '1', 'yes', ''])(
    'M4-10 the value %j for SCHEDULER_ENABLED stops the start instead of being read as on or off',
    (value) => {
      expect(() => schedulerEnabled({ SCHEDULER_ENABLED: value })).toThrow(ConfigError);
    },
  );
});

describe('M4-10 no handle is left behind', () => {
  it('M4-10 with the real timer a start and a stop leave the process as it was', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    const { job } = counting('daily', { kind: 'daily', runUtc: '03:00' });
    const scheduler = new Scheduler({ clock, logger: log.logger, jobs: [job] });
    scheduler.start();
    // The timer must not keep the process alive by itself: the server does that, and a stop is not to wait for a run.
    const handle = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    spy.mockRestore();
    await scheduler.stop();
    const after = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    expect(after).toBe(before);
  });
});

describe('M4-10 what a service gets from the environment', () => {
  const job = {
    name: 'daily',
    schedule: { kind: 'every', seconds: 5 },
    run: () => Promise.resolve(),
  } as const;

  it('M4-10 the scheduler is provided when the jobs are on and not when they are off', () => {
    const options = { clock, timers, logger: log.logger, jobs: [job] };
    expect(schedulerProviders({ NODE_ENV: 'test' }, options)).toEqual([]);
    const [on] = schedulerProviders({ NODE_ENV: 'test', SCHEDULER_ENABLED: 'true' }, options);
    expect(on?.provide).toBe(SCHEDULER);
    expect(on?.useValue.describe()).toEqual([
      { name: 'daily', schedule: { kind: 'every', seconds: 5 } },
    ]);
  });

  it('M4-10 a schedule that cannot work stops the start even where the jobs are off', () => {
    const bad = { ...job, schedule: { kind: 'daily', runUtc: '25:00' } } as const;
    expect(() =>
      schedulerProviders({ NODE_ENV: 'test' }, { clock, timers, logger: log.logger, jobs: [bad] }),
    ).toThrow(RangeError);
  });
});
