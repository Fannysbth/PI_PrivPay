import { isUnreachable } from '../src/privacy-http';

// Which database errors mean "the database is away" (503, invariant 8) and which are the service's own fault (500).
describe('M2-12 isUnreachable', () => {
  it.each([['ECONNREFUSED'], ['ETIMEDOUT'], ['57P01'], ['08006'], ['53300']])(
    'M2-12 invariant 8 code %s is the database being away',
    (code) => {
      expect(isUnreachable(Object.assign(new Error('x'), { code }))).toBe(true);
    },
  );

  it.each([['timeout exceeded when trying to connect'], ['Connection terminated unexpectedly']])(
    'M2-12 invariant 8 message "%s" is the database being away',
    (message) => {
      expect(isUnreachable(new Error(message))).toBe(true);
    },
  );

  it.each([['23505'], ['42501'], ['22P02'], ['P0001']])(
    'M2-12 code %s is not the database being away',
    (code) => {
      expect(isUnreachable(Object.assign(new Error('x'), { code }))).toBe(false);
    },
  );

  it('M2-12 a value that is not an error is not the database being away', () => {
    expect(isUnreachable(undefined)).toBe(false);
    expect(isUnreachable('ECONNREFUSED')).toBe(false);
  });
});
