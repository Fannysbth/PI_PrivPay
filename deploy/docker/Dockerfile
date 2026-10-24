# One Dockerfile for every Node service of PrivPay (DK-01a); the service is chosen by build arguments, so each service
# gets its own image holding only its production dependencies. Tag and digest are pinned: no :latest.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# (false positive: the tag and digest are pinned in NODE_IMAGE above, which hadolint cannot resolve through ARG)
# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS build
ENV COREPACK_HOME=/opt/corepack \
    CI=true
WORKDIR /repo
COPY . .
# The pnpm version comes from "packageManager" in package.json; secrets/, .env and node_modules never reach this context.
RUN corepack enable && corepack prepare --activate \
    && pnpm install --frozen-lockfile \
    && pnpm build
ARG SERVICE_PKG
# Tests, sources and build state stay behind: the image runs dist/ only.
RUN test -n "$SERVICE_PKG" && pnpm --filter "$SERVICE_PKG" --prod deploy /out \
    && rm -rf /out/test /out/src /out/tsconfig.build.json /out/tsconfig.build.tsbuildinfo /out/pnpm-lock.yaml /out/pnpm-workspace.yaml

# (false positive: the tag and digest are pinned in NODE_IMAGE above, which hadolint cannot resolve through ARG)
# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS runtime
ARG SERVICE_DIR
ENV TZ=UTC
# npm and npx are never used at run time (the command is "node dist/main.js"); the npm bundled in the base image carries
# HIGH findings in its own dependencies (brace-expansion, undici, http-cache-semantics) that no pinned patch removes.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
# /app/service is where the service runs; its path under /app mirrors the repo, so the migration runner (which looks for
# services/<name>/migrations under the working directory) finds its files.
COPY --from=build --chown=root:root /out /app/${SERVICE_DIR}
RUN test -n "$SERVICE_DIR" && ln -s "/app/${SERVICE_DIR}" /app/service \
    && mkdir -p /state && chown node:node /state
USER node
CMD ["node", "/app/service/dist/main.js"]
