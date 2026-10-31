import { randomInt } from 'node:crypto';
import { DomainError, type HttpClient, type TokenCache } from '@privpay/common';
import { z } from 'zod';

// ADR-0017 item 4, ADR-0005: step A2 of the registration and its compensation, for the two identity providers. The flow
// holds the customer id and an opaque handle; only the directory knows what a handle is (the id itself at the dev IdP,
// the id of the user record at Keycloak, whose own ids are not CUST-nnnnnn).
export interface DirectoryUser {
  readonly customerId: string;
  readonly handle: string;
}

export interface UserDirectory {
  create(username: string): Promise<DirectoryUser>;
  /** Idempotent: a user that is already gone is not an error, because the compensation may be repeated. */
  remove(handle: string): Promise<void>;
}

type Deps = {
  readonly http: Pick<HttpClient, 'request'>;
  readonly token: Pick<TokenCache, 'get'>;
};

const createdAtDevIdp = z.object({ customer_id: z.string().regex(/^CUST-[0-9]{6}$/) });

export function devIdpUserDirectory({ http, token }: Deps): UserDirectory {
  return {
    async create(username) {
      const response = await http.request({
        service: 'idp',
        method: 'POST',
        path: '/admin/users',
        body: { username },
        idempotent: false,
        authorization: `Bearer ${await token.get()}`,
      });
      const parsed = createdAtDevIdp.safeParse(response.body);
      if (response.status === 201 && parsed.success) {
        return { customerId: parsed.data.customer_id, handle: parsed.data.customer_id };
      }
      // A username that is taken is the caller's to change; anything else is the IdP being away or refusing us.
      if (response.status === 422) throw new DomainError('VALIDATION_ERROR', 'username');
      throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
    },
    async remove(handle) {
      const response = await http.request({
        service: 'idp',
        method: 'DELETE',
        path: `/admin/users/${handle}`,
        idempotent: true,
        authorization: `Bearer ${await token.get()}`,
      });
      if (response.status < 200 || response.status > 299) {
        throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
      }
    },
  };
}

const foundUsers = z.array(z.object({ id: z.string().min(1), username: z.string() }));
const roleRepresentation = z.looseObject({ id: z.string().min(1), name: z.literal('customer') });

export interface KeycloakDirectoryOptions extends Deps {
  readonly realm: string;
  /** The one test password of the users (ADR-0017 item 5); read from a file by the caller, never logged. */
  readonly userPassword: string;
  /** `CUST-` and six random digits (N-08); replaceable so that a test can force a clash. */
  readonly newCustomerId?: () => string;
  readonly maxAttempts?: number;
}

const randomCustomerId = (): string => `CUST-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;

/**
 * The Admin API of Keycloak, with the client `idp-admin` only. The customer id is a candidate checked against the attribute
 * search before the user is made and again after (Keycloak has no unique attribute, so two registrations can pick the same
 * id between the check and the creation: the one that finds it twice takes its own user back and tries another).
 */
export function keycloakUserDirectory(options: KeycloakDirectoryOptions): UserDirectory {
  const { http, token, realm } = options;
  const newCustomerId = options.newCustomerId ?? randomCustomerId;
  const maxAttempts = options.maxAttempts ?? 5;
  const base = `/admin/realms/${realm}`;

  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    idempotent = method !== 'POST',
  ) =>
    http.request({
      service: 'idp',
      method,
      path: `${base}${path}`,
      ...(body === undefined ? {} : { body }),
      idempotent,
      authorization: `Bearer ${await token.get()}`,
    });

  // The candidate goes only to the IdP that will own it, in the query of its own search; it is not logged by the client.
  const usersWith = async (customerId: string) => {
    const response = await call(
      'GET',
      `/users?q=${encodeURIComponent(`customer_id:${customerId}`)}`,
    );
    const parsed = foundUsers.safeParse(response.body);
    if (response.status !== 200 || !parsed.success)
      throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
    return parsed.data;
  };

  const remove = async (handle: string): Promise<void> => {
    const response = await call('DELETE', `/users/${encodeURIComponent(handle)}`);
    if (response.status !== 204 && response.status !== 404) {
      throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
    }
  };

  const giveCustomerRole = async (handle: string): Promise<void> => {
    const role = await call('GET', '/roles/customer');
    const parsed = roleRepresentation.safeParse(role.body);
    if (role.status !== 200 || !parsed.success) throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
    const mapped = await call(
      'POST',
      `/users/${encodeURIComponent(handle)}/role-mappings/realm`,
      [parsed.data],
      true,
    );
    if (mapped.status !== 204) throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
  };

  return {
    remove,
    async create(username) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const customerId = newCustomerId();
        if ((await usersWith(customerId)).length > 0) continue;
        const created = await call('POST', '/users', {
          username,
          enabled: true,
          attributes: { customer_id: [customerId] },
          credentials: [{ type: 'password', value: options.userPassword, temporary: false }],
        });
        if (created.status === 409) throw new DomainError('VALIDATION_ERROR', 'username');
        if (created.status !== 201) throw new DomainError('SERVICE_UNAVAILABLE', 'idp');

        const holders = await usersWith(customerId);
        const mine = holders.find((user) => user.username === username);
        if (mine === undefined) throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
        if (holders.length > 1) {
          await remove(mine.id);
          continue;
        }
        try {
          await giveCustomerRole(mine.id);
        } catch (error) {
          // A user without a role cannot sign in and the flow does not know it exists: take it back here.
          await remove(mine.id).catch(() => undefined);
          throw error;
        }
        return { customerId, handle: mine.id };
      }
      throw new DomainError('SERVICE_UNAVAILABLE', 'idp');
    },
  };
}
