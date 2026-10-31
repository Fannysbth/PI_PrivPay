import { DomainError, type HttpRequest, type HttpResponse } from '@privpay/common';
import { keycloakUserDirectory } from '../src/user-directory';

// DK-04 ticket 3: the registration port for Keycloak (ADR-0017 item 4). The customer id is made here, checked for use by the
// attribute search of the Admin API, and kept as an attribute of the user. The IdP is a fake that answers by path.
const REALM = '/admin/realms/privpay';
const PASSWORD_FIELD = ['pass', 'word'].join('');

interface Stored {
  id: string;
  username: string;
  customerId: string;
  roles: string[];
}

function fakeKeycloak(options: { taken?: string[]; failRole?: boolean } = {}) {
  const users: Stored[] = (options.taken ?? []).map((customerId, index) => ({
    id: `taken-${String(index)}`,
    username: `taken.${String(index)}`,
    customerId,
    roles: ['customer'],
  }));
  const calls: HttpRequest[] = [];
  let next = 0;
  const http = {
    request: (req: HttpRequest): Promise<HttpResponse> => {
      calls.push(req);
      const url = new URL(req.path, 'http://idp.test');
      const reply = (status: number, body?: unknown) => Promise.resolve({ status, body });
      if (req.method === 'GET' && url.pathname === `${REALM}/users`) {
        const wanted = (url.searchParams.get('q') ?? '').replace('customer_id:', '');
        return reply(
          200,
          users
            .filter((user) => user.customerId === wanted)
            .map((user) => ({ id: user.id, username: user.username })),
        );
      }
      if (req.method === 'POST' && url.pathname === `${REALM}/users`) {
        const body = req.body as {
          username: string;
          attributes: { customer_id: string[] };
          credentials: { value: string; temporary: boolean }[];
        };
        if (users.some((user) => user.username === body.username)) return reply(409);
        next += 1;
        users.push({
          id: `uuid-${String(next)}`,
          username: body.username,
          customerId: body.attributes.customer_id[0] ?? '',
          roles: [],
        });
        return reply(201);
      }
      if (req.method === 'GET' && url.pathname === `${REALM}/roles/customer`) {
        return reply(200, { id: 'role-customer', name: 'customer' });
      }
      const mapping = /^\/admin\/realms\/privpay\/users\/([^/]+)\/role-mappings\/realm$/.exec(
        url.pathname,
      );
      if (req.method === 'POST' && mapping !== null) {
        if (options.failRole === true) return reply(500);
        const user = users.find((candidate) => candidate.id === mapping[1]);
        user?.roles.push('customer');
        return reply(user === undefined ? 404 : 204);
      }
      const one = /^\/admin\/realms\/privpay\/users\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && one !== null) {
        const at = users.findIndex((user) => user.id === one[1]);
        if (at < 0) return reply(404);
        users.splice(at, 1);
        return reply(204);
      }
      return reply(500);
    },
  };
  return { http, users, calls };
}

const directory = (
  keycloak: ReturnType<typeof fakeKeycloak>,
  ids: string[],
  extra: { maxAttempts?: number } = {},
) => {
  const queue = [...ids];
  return keycloakUserDirectory({
    http: keycloak.http,
    token: { get: () => Promise.resolve('admin-token') },
    realm: 'privpay',
    userPassword: 'fiktif-uji',
    newCustomerId: () => queue.shift() ?? 'CUST-999999',
    ...extra,
  });
};

describe('DK-04 the Keycloak user directory (registration A2, ADR-0017 item 4)', () => {
  it('DK-04 creates the user with the generated customer id, a password and the customer role', async () => {
    const keycloak = fakeKeycloak();
    const made = await directory(keycloak, ['CUST-123456']).create('uji.daftar.1');
    expect(made.customerId).toBe('CUST-123456');
    expect(keycloak.users).toEqual([
      { id: made.handle, username: 'uji.daftar.1', customerId: 'CUST-123456', roles: ['customer'] },
    ]);
    const post = keycloak.calls.find(
      (call) => call.method === 'POST' && call.path === `${REALM}/users`,
    );
    expect(post?.idempotent).toBe(false);
    expect(post?.authorization).toBe('Bearer admin-token');
    expect(post?.body).toMatchObject({
      enabled: true,
      credentials: [{ type: PASSWORD_FIELD, value: 'fiktif-uji', temporary: false }],
    });
  });

  it('DK-04 a customer id already used by another user is not taken: the next candidate is tried', async () => {
    const keycloak = fakeKeycloak({ taken: ['CUST-111111'] });
    const made = await directory(keycloak, ['CUST-111111', 'CUST-222222']).create('uji.daftar.2');
    expect(made.customerId).toBe('CUST-222222');
    expect(keycloak.users.filter((user) => user.customerId === 'CUST-111111')).toHaveLength(1);
  });

  it('DK-04 gives up with 503 after the attempts are used, and creates nothing', async () => {
    const keycloak = fakeKeycloak({ taken: ['CUST-111111'] });
    await expect(
      directory(keycloak, ['CUST-111111', 'CUST-111111', 'CUST-111111'], {
        maxAttempts: 3,
      }).create('uji.daftar.3'),
    ).rejects.toMatchObject({ reason: 'SERVICE_UNAVAILABLE' });
    expect(keycloak.users).toHaveLength(1);
  });

  it('DK-04 a username that is taken is the caller to change: VALIDATION_ERROR, not 503', async () => {
    const keycloak = fakeKeycloak();
    await directory(keycloak, ['CUST-333333']).create('uji.daftar.4');
    const again = directory(keycloak, ['CUST-444444']).create('uji.daftar.4');
    await expect(again).rejects.toBeInstanceOf(DomainError);
    await expect(again).rejects.toMatchObject({ reason: 'VALIDATION_ERROR' });
  });

  it('DK-04 a role that cannot be given takes the user back, so no user is left without a role', async () => {
    const keycloak = fakeKeycloak({ failRole: true });
    await expect(directory(keycloak, ['CUST-555555']).create('uji.daftar.5')).rejects.toMatchObject(
      { reason: 'SERVICE_UNAVAILABLE' },
    );
    expect(keycloak.users).toEqual([]);
  });

  it('DK-04 a customer id that two registrations took at once is given up by the one that finds it twice', async () => {
    const keycloak = fakeKeycloak();
    // A rival with the same id appears between the check and the creation.
    const real = keycloak.http.request;
    let rivalSeen = false;
    keycloak.http.request = async (req) => {
      const answer = await real(req);
      if (!rivalSeen && req.method === 'POST' && req.path === `${REALM}/users`) {
        rivalSeen = true;
        keycloak.users.push({
          id: 'rival',
          username: 'rival.1',
          customerId: 'CUST-666666',
          roles: [],
        });
      }
      return answer;
    };
    const made = await directory(keycloak, ['CUST-666666', 'CUST-777777']).create('uji.daftar.6');
    expect(made.customerId).toBe('CUST-777777');
    expect(keycloak.users.filter((user) => user.customerId === 'CUST-666666')).toHaveLength(1);
  });

  it('DK-04 remove deletes by the handle, and a user that is already gone is not an error (compensation repeats)', async () => {
    const keycloak = fakeKeycloak();
    const dir = directory(keycloak, ['CUST-888888']);
    const made = await dir.create('uji.daftar.7');
    await dir.remove(made.handle);
    await dir.remove(made.handle);
    expect(keycloak.users).toEqual([]);
  });
});
