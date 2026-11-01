import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DK-04c (ADR-0017 items 3, 5): the realm is rendered from secrets, one password per class of user, and a service token
// is asked for one audience at a time. The real Keycloak is exercised by tests/docker/keycloak-claims.docker.spec.ts;
// this spec holds the shape of what is rendered, without Docker.
interface Rendered {
  clients: {
    clientId: string;
    publicClient?: boolean;
    secret?: string;
    protocolMappers?: { protocolMapper: string }[];
    optionalClientScopes?: string[];
    defaultClientScopes?: string[];
    directAccessGrantsEnabled?: boolean;
  }[];
  users: {
    username: string;
    realmRoles?: string[];
    credentials?: { value: string }[];
    serviceAccountClientId?: string;
    clientRoles?: Record<string, string[]>;
  }[];
  clientScopes: { name: string }[];
}
interface RealmModule {
  renderRealm(input: {
    clientSecrets: Record<string, string>;
    passwords: Record<string, string>;
  }): Rendered;
  PASSWORD_FILES: Record<string, string>;
  audienceScope(service: string): string;
  classOfUser(username: string): string;
  SERVICE_CLIENTS: Record<string, string[]>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realm = require(
  join(__dirname, '..', '..', 'scripts', 'docker', 'keycloak-realm.cjs'),
) as RealmModule;

const pad = (name: string): string => `${name}-fixture-value-0123456789`;
const secrets = (): Record<string, string> =>
  Object.fromEntries(
    [...Object.keys(realm.SERVICE_CLIENTS), 'idp-admin', 'admin-console'].map((n) => [n, pad(n)]),
  );
const passwords = (): Record<string, string> =>
  Object.fromEntries(Object.keys(realm.PASSWORD_FILES).map((k) => [k, pad(`pw-${k}`)]));
const render = (
  overrides: { clientSecrets?: Record<string, string>; passwords?: Record<string, string> } = {},
): Rendered =>
  realm.renderRealm({
    clientSecrets: overrides.clientSecrets ?? secrets(),
    passwords: overrides.passwords ?? passwords(),
  });

describe('DK-04c one password per class of user', () => {
  it('DK-04c there are five classes, each with its own file', () => {
    expect(Object.keys(realm.PASSWORD_FILES).sort()).toEqual(
      ['admin', 'auditor', 'bank', 'customer', 'fraud_analyst'].sort(),
    );
    expect(new Set(Object.values(realm.PASSWORD_FILES)).size).toBe(5);
  });

  it('DK-04c every test user gets the password of its own class and no other', () => {
    const rendered = render();
    const byRole = passwords();
    const humans = rendered.users.filter((user) => user.realmRoles !== undefined);
    expect(humans.length).toBeGreaterThan(0);
    for (const user of humans) {
      const role = user.realmRoles?.[0] ?? '';
      expect(user.credentials?.[0]?.value).toBe(byRole[role]);
    }
  });

  it('DK-04c two classes sharing one password is refused at render time', () => {
    const same = { ...passwords(), auditor: pad('pw-admin') };
    expect(() => render({ passwords: same })).toThrow(/distinct/);
  });

  it('DK-04c a missing or short password is refused', () => {
    expect(() => render({ passwords: { ...passwords(), bank: 'short' } })).toThrow(/bank/);
    const without: Record<string, string> = passwords();
    delete without['auditor'];
    expect(() => render({ passwords: without })).toThrow(/auditor/);
  });
});

describe('DK-04c admin-console needs its client secret', () => {
  it('DK-04c admin-console is confidential with a secret; customer-app and bank-simulator stay public', () => {
    const clients = render().clients;
    const find = (id: string) => clients.find((client) => client.clientId === id);
    expect(find('admin-console')).toMatchObject({
      publicClient: false,
      secret: pad('admin-console'),
      directAccessGrantsEnabled: true,
    });
    expect(find('customer-app')?.publicClient).toBe(true);
    expect(find('bank-simulator')?.publicClient).toBe(true);
  });

  it('DK-04c a missing admin-console secret is refused', () => {
    const without = secrets();
    delete without['admin-console'];
    expect(() => render({ clientSecrets: without })).toThrow(/admin-console/);
  });
});

describe('DK-04c service accounts name no audience unless one is asked for (ADR-0017)', () => {
  it('DK-04c no service account carries the audience mapper, and each may ask only for its own row', () => {
    const rendered = render();
    for (const [name, targets] of Object.entries(realm.SERVICE_CLIENTS)) {
      const client = rendered.clients.find((candidate) => candidate.clientId === name);
      expect(client?.protocolMappers ?? []).toEqual([]);
      expect(client?.defaultClientScopes).toEqual(['basic']);
      expect([...(client?.optionalClientScopes ?? [])].sort()).toEqual(
        targets.map((target) => `aud-${target}`).sort(),
      );
    }
    const scopes = rendered.clientScopes.map((scope) => scope.name);
    expect(scopes).toContain('basic');
    expect(scopes).toContain('aud-privacy-service');
  });

  it('DK-04c the admin client has no audience scope at all', () => {
    const admin = render().clients.find((client) => client.clientId === 'idp-admin');
    expect(admin?.optionalClientScopes).toEqual([]);
    expect(admin?.defaultClientScopes).toEqual(['basic']);
  });
});

describe('DK-04c the name of the audience scope is the same in the realm, in common, and in the Kong plugin', () => {
  it('DK-04c aud-<service>: audienceScope(), the request of createIdpTokenCache, and the Lua literal agree', () => {
    const lua = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'services',
        'gateway',
        'plugins',
        'privacy-tokenizer',
        'kong',
        'plugins',
        'privacy-tokenizer',
        'privacy.lua',
      ),
      'utf8',
    );
    const idp = readFileSync(
      join(__dirname, '..', '..', 'packages', 'common', 'src', 'idp.ts'),
      'utf8',
    );
    expect(lua).toContain(`scope = "${realm.audienceScope('privacy-service')}"`);
    expect(idp).toContain('`aud-${grant.audience}`');
  });

  it('DK-04c classOfUser knows the test users and refuses an unknown one', () => {
    expect(realm.classOfUser('admin.uji.2')).toBe('admin');
    expect(realm.classOfUser('analis.uji.1')).toBe('fraud_analyst');
    expect(() => realm.classOfUser('nobody')).toThrow(/nobody/);
  });
});
