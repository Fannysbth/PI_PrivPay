import { z } from 'zod';
import type { Clock } from './clock';
import { DomainError } from './errors';
import type { HttpClient, HttpRequest } from './http';
import { createTokenCache, type TokenCache } from './token-cache';

// DK-04: which identity provider the services talk to, and how. One place for the paths, the shape of the token request
// and the choice of keys, so that five services do not keep five copies. The default is the dev IdP (ADR-0004); Keycloak
// (ADR-0017) is chosen by configuration only. Both answer a token request with `access_token` and `expires_in`.

export const IDP_KINDS = ['dev-idp', 'keycloak'] as const;
export type IdpKind = (typeof IDP_KINDS)[number];

export interface IdpChoice {
  readonly kind: IdpKind;
  /** The realm of Keycloak; it goes into a path, so only a plain name is accepted. */
  readonly realm: string;
}

export const DEV_IDP: IdpChoice = { kind: 'dev-idp', realm: 'privpay' };

const REALM = /^[A-Za-z0-9_-]{1,64}$/;

/** Part of `idpConfigShape`: every service that reads the issuer's keys or asks it for a token gets the same two settings. */
export const idpChoiceShape = {
  IDP_KIND: z.enum(IDP_KINDS).default('dev-idp'),
  IDP_REALM: z.string().regex(REALM).default('privpay'),
};

export const idpOf = (config: { IDP_KIND: IdpKind; IDP_REALM: string }): IdpChoice => ({
  kind: config.IDP_KIND,
  realm: config.IDP_REALM,
});

export function idpEndpoints(idp: IdpChoice): { token: string; jwks: string } {
  if (idp.kind === 'dev-idp') return { token: '/token', jwks: '/.well-known/jwks.json' };
  if (!REALM.test(idp.realm)) throw new RangeError('the realm must be a plain name');
  const base = `/realms/${idp.realm}/protocol/openid-connect`;
  return { token: `${base}/token`, jwks: `${base}/certs` };
}

export type TokenGrant =
  | {
      readonly type: 'client-credentials';
      readonly clientId: string;
      readonly clientSecret: string;
      /**
       * The service the token is for. The dev IdP narrows `aud` to it. Keycloak ignores it: the audiences of an account
       * come from its roles in the realm (ADR-0017), so a token names every service the account may call.
       */
      readonly audience?: string;
    }
  | {
      readonly type: 'login';
      readonly clientId: string;
      readonly username: string;
      /** Keycloak needs the password of the test user; the dev IdP signs a user in by name. */
      readonly password?: string;
    };

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().min(1).max(300),
});

interface Options {
  readonly http: Pick<HttpClient, 'request'>;
  readonly clock: Clock;
  readonly idp: IdpChoice;
  readonly grant: TokenGrant;
}

function requestFor(
  idp: IdpChoice,
  grant: TokenGrant,
): Pick<HttpRequest, 'path' | 'body' | 'form'> {
  const path = idpEndpoints(idp).token;
  if (idp.kind === 'dev-idp') {
    return grant.type === 'client-credentials'
      ? {
          path,
          body: {
            grant_type: 'client_credentials',
            client_id: grant.clientId,
            client_secret: grant.clientSecret,
            ...(grant.audience === undefined ? {} : { audience: [grant.audience] }),
          },
        }
      : {
          path,
          body: { grant_type: 'dev_login', client_id: grant.clientId, username: grant.username },
        };
  }
  return grant.type === 'client-credentials'
    ? {
        path,
        form: {
          grant_type: 'client_credentials',
          client_id: grant.clientId,
          client_secret: grant.clientSecret,
        },
      }
    : {
        path,
        form: {
          grant_type: 'password',
          client_id: grant.clientId,
          username: grant.username,
          password: grant.password ?? '',
        },
      };
}

/** A service token that is asked for when needed and reused until shortly before it ends (NFR-21). */
export function createIdpTokenCache({ http, clock, idp, grant }: Options): TokenCache {
  if (idp.kind === 'keycloak' && grant.type === 'login' && (grant.password ?? '') === '') {
    throw new RangeError('Keycloak needs the password of the user');
  }
  const request = requestFor(idp, grant);
  return createTokenCache({
    clock,
    fetchToken: async () => {
      const answer = await http.request({
        service: 'idp',
        method: 'POST',
        ...request,
        idempotent: true,
      });
      const parsed = tokenAnswer.safeParse(answer.body);
      if (answer.status !== 200 || !parsed.success) {
        throw new DomainError('SERVICE_UNAVAILABLE', 'token');
      }
      return {
        token: parsed.data.access_token,
        expiresAt: new Date(clock.now().getTime() + parsed.data.expires_in * 1000),
      };
    },
  });
}

const signingKey = z.looseObject({
  kty: z.literal('RSA'),
  kid: z.string().min(1).max(128),
  alg: z.literal('RS256'),
  use: z.literal('sig'),
  n: z.string().min(1),
  e: z.string().min(1),
});

/**
 * What a JWKS answer is reduced to before the services read it. Keycloak publishes a signing key and an encryption key
 * and extra members (certificates): only the one RS256 signing key is kept, and only its public members, so nothing
 * else is ever imported. Exactly one is required (Kong finds the key by issuer, so two cannot both be served).
 */
export function signingKeysOf(body: unknown): { keys: Record<string, string>[] } {
  const keys = z.object({ keys: z.array(z.unknown()) }).safeParse(body);
  const signing = keys.success
    ? keys.data.keys.flatMap((candidate) => {
        const parsed = signingKey.safeParse(candidate);
        return parsed.success
          ? [
              {
                kty: parsed.data.kty,
                kid: parsed.data.kid,
                alg: parsed.data.alg,
                use: parsed.data.use,
                n: parsed.data.n,
                e: parsed.data.e,
              },
            ]
          : [];
      })
    : [];
  if (signing.length !== 1) throw new DomainError('SERVICE_UNAVAILABLE', 'jwks');
  return { keys: signing };
}
