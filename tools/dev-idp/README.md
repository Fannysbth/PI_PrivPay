# dev-idp

A fake JWT issuer for the **local phase only** (ADR-0004, ADR-0007). It stands in for Keycloak until the Docker phase
(DK-04) and must never run anywhere real tokens are expected: it refuses to start unless `NODE_ENV` is `development` or `test`, or when
`DEV_IDP_ENABLED` is not exactly `true`, and it only binds to `127.0.0.1`.

## Run

```
corepack pnpm --filter @privpay/dev-idp run make-secrets   # once: one random secret per service account in secrets/
corepack pnpm build
NODE_ENV=development DEV_IDP_ENABLED=true PRIVACY_MODE=proposed PORT=<port> node tools/dev-idp/dist/main.js
```

`make-secrets` writes `secrets/<client>_client_secret` (never overwrites, prints file names only). The secrets directory
is `DEV_IDP_SECRETS_DIR` (default `./secrets`). The RS256 key is made when the process starts and is never written
anywhere; every restart publishes a new key and forgets the customers created through the admin API.

| Variable | Meaning |
| --- | --- |
| `DEV_IDP_ENABLED` | must be `true` |
| `NODE_ENV` | must be `development` or `test`; unset or anything else (including `production`) stops the start |
| `ACCESS_TOKEN_TTL_SECONDS` | token lifetime, 1 to 300 (default 300) |
| `DEV_IDP_SECRETS_DIR` | where the client secrets are read from |
| `PRIVACY_MODE`, `PORT`, `BIND_HOST`, `LOG_LEVEL` | the shared service bootstrap |

## Endpoints

| Endpoint | Who | Notes |
| --- | --- | --- |
| `POST /token` `client_credentials` | the five service accounts | `{grant_type, client_id, client_secret, audience}`; `audience` is a service id or a list, limited per client (`src/registry.ts`) |
| `POST /token` `dev_login` | `customer-app`, `admin-console`, `bank-simulator` | `{grant_type, client_id, username}`; no password in the local phase; a user signs in at its own client only |
| `GET /.well-known/jwks.json` | anyone on loopback | the public key |
| `POST /admin/users` | `api-gateway` (token for audience `dev-idp`) | `{username}` only; returns `{id, customer_id, username}`; numbers continue after the seed (`CUST-000104`, ...) |
| `DELETE /admin/users/{customer_id}` | `api-gateway` | idempotent; seed users cannot be deleted |

Tokens are RS256 with `iss=privpay-dev-idp`, `azp` = the client, `aud` per service (service accounts) or per role (people,
platform spec 7 item 6), `roles` (people: exactly one), and `customer_id` only for `customer-app`. The seed accounts
(`users.dev.json`) are fictitious: 3 customers (`CUST-000101..103`), 2 admins, 2 auditors, 1 fraud analyst, 1 bank.

`dev_login` takes a username and nothing else, so any process on this machine can obtain a token for any seed user. That
is the point of a local fake and the reason for the guards above; it is also why the dev IdP must never be reachable from
another host. `make-secrets` asks for owner-only file mode, which Windows ignores: keep `secrets/` in a folder only your
account can read.

The mapping of these claims to Keycloak (protocol mappers, user attributes, clients, audiences) is a debt of the Docker
phase (DK-04).
