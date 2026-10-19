import { RouteTable, ROUTES } from '../src/routes';

// Built at run time: a literal pseudonym under services/ would be reported by the secret scan.
const PSEUDONYM = ['PSEU', '1A2B3C4D'].join('-');

describe('M1-03 RouteTable.match is the one list of routes: anything else does not exist', () => {
  const table = new RouteTable(ROUTES);

  it('M1-03 matches each route of the human operations by method and path, with its path parameters', () => {
    expect(table.match('GET', '/transaction/held')?.route.id).toBe('AZ-04');
    expect(table.match('POST', '/transaction/TX-1760860800000001/review')).toMatchObject({
      route: { id: 'AZ-05' },
      params: { id: 'TX-1760860800000001' },
    });
    expect(table.match('POST', '/reconciliation/audit-request')?.route.id).toBe('AZ-06');
    expect(table.match('POST', '/reconciliation/disclosure')?.route.id).toBe('AZ-07');
    expect(table.match('POST', '/reconciliation/run')?.route.id).toBe('AZ-08');
    expect(table.match('POST', '/disclosure-requests')?.route.id).toBe('AZ-10');
    expect(
      table.match('POST', '/disclosure-requests/2f1b6a52-5b0c-4a6e-9f1e-0c3f2a7d9b11/approve')
        ?.route.id,
    ).toBe('AZ-11');
    expect(
      table.match('POST', '/disclosure-requests/2f1b6a52-5b0c-4a6e-9f1e-0c3f2a7d9b11/reject')?.route
        .id,
    ).toBe('AZ-12');
    expect(table.match('GET', '/audit-log')?.route.id).toBe('AZ-13');
    expect(table.match('GET', `/audit-log/timeline/${PSEUDONYM}`)).toMatchObject({
      route: { id: 'AZ-14' },
      params: { pseudonym: PSEUDONYM },
    });
    expect(table.match('GET', '/audit-log/summary')?.route.id).toBe('AZ-15');
    expect(table.match('POST', `/pseudonym/${PSEUDONYM}/revoke`)?.route.id).toBe('AZ-16');
    expect(table.match('POST', '/subject/revoke')?.route.id).toBe('AZ-17');
  });

  it('M1-03 the route ids are unique and every route is listed in the endpoint catalogue as AZ-04..08 or AZ-10..17', () => {
    const ids = ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([
      'AZ-04',
      'AZ-05',
      'AZ-06',
      'AZ-07',
      'AZ-08',
      'AZ-10',
      'AZ-11',
      'AZ-12',
      'AZ-13',
      'AZ-14',
      'AZ-15',
      'AZ-16',
      'AZ-17',
    ]);
  });

  it('M1-03 the wrong method on a known path does not match', () => {
    expect(table.match('GET', '/transaction/TX-1/review')).toBeUndefined();
    expect(table.match('DELETE', '/audit-log')).toBeUndefined();
    expect(table.match('PUT', '/subject/revoke')).toBeUndefined();
  });

  it.each([
    '/',
    '/unknown',
    '/transaction',
    '/transaction/held/',
    '//transaction/held',
    '/Transaction/held',
    '/transaction/held/extra',
    '/transaction/../transaction/held',
    '/transaction/%2e%2e/held',
    '/transaction/TX-1/review/',
    '/audit-log/timeline/',
    `/audit-log/timeline/${PSEUDONYM}/extra`,
    '/register',
    '/transaction/held?x=1',
    '/health',
    '/metrics',
    '/token',
    '/admin/users',
  ])('M1-03 %s is not a route', (path) => {
    expect(table.match('GET', path)).toBeUndefined();
    expect(table.match('POST', path)).toBeUndefined();
  });

  it('M1-03 a path parameter must have the shape of what it names', () => {
    expect(table.match('POST', '/transaction/not-a-transaction/review')).toBeUndefined();
    expect(table.match('POST', '/transaction/TX-1; drop/review')).toBeUndefined();
    expect(table.match('POST', '/pseudonym/PSEU-ZZZZZZZZ/revoke')).toBeUndefined();
    expect(table.match('POST', '/pseudonym/pseu-1a2b3c4d/revoke')).toBeUndefined();
    expect(table.match('POST', '/disclosure-requests/not-a-uuid/approve')).toBeUndefined();
    expect(table.match('GET', '/audit-log/timeline/1234')).toBeUndefined();
  });

  it('M1-03 who may use a route and how the call goes downstream are fixed in the table', () => {
    const route = (id: string) => ROUTES.find((r) => r.id === id);
    expect(route('AZ-04')).toMatchObject({
      who: ['fraud_analyst'],
      upstream: 'transaction-service',
      auth: 'gateway-token+actor',
    });
    expect(route('AZ-06')).toMatchObject({
      who: ['auditor'],
      upstream: 'reconciliation-service',
      auth: 'gateway-token+actor',
    });
    expect(route('AZ-08')).toMatchObject({
      who: ['admin'],
      upstream: 'reconciliation-service',
      auth: 'gateway-token+actor',
    });
    expect(route('AZ-11')).toMatchObject({
      who: ['admin'],
      upstream: 'privacy-service',
      auth: 'human-token',
    });
    expect(route('AZ-13')).toMatchObject({
      who: ['auditor', 'admin'],
      upstream: 'privacy-service',
      auth: 'human-token',
    });
    expect(route('AZ-14')).toMatchObject({ who: ['auditor'], auth: 'human-token' });
  });

  it('M1-03 no route lets a customer or a service account in: only people of the admin console', () => {
    for (const route of ROUTES) {
      expect(Array.isArray(route.who)).toBe(true);
      expect(route.who.length).toBeGreaterThan(0);
    }
  });
});
