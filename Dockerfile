# syntax=docker/dockerfile:1.7

# The tag is human-readable; the manifest-list digest makes the base immutable
# while retaining multi-architecture resolution.
ARG NODE_IMAGE=node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114

FROM ${NODE_IMAGE} AS tooling

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable \
  && corepack prepare pnpm@11.6.0 --activate \
  && pnpm config set store-dir /pnpm/store

WORKDIR /workspace

FROM tooling AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/breaker-core/package.json packages/breaker-core/package.json
COPY packages/breaker-store/package.json packages/breaker-store/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/detectors/package.json packages/detectors/package.json
COPY packages/diagnosis/package.json packages/diagnosis/package.json
COPY packages/otel/package.json packages/otel/package.json
COPY packages/preflight/package.json packages/preflight/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY services/broken-agent/package.json services/broken-agent/package.json
COPY services/control-plane/package.json services/control-plane/package.json

RUN --mount=type=cache,id=fuse-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS build

COPY tsconfig.base.json ./
COPY packages ./packages
COPY services/control-plane ./services/control-plane
COPY LICENSE ./

RUN pnpm --filter @fuse/control-plane... run build
RUN --mount=type=cache,id=fuse-pnpm-store,target=/pnpm/store \
  pnpm --filter @fuse/control-plane deploy --prod --legacy /opt/fuse-control-plane

FROM ${NODE_IMAGE} AS runtime

ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=0.1.0

LABEL org.opencontainers.image.title="Fuse control plane" \
  org.opencontainers.image.description="OTel-native cost circuit breaker control plane for AI agents" \
  org.opencontainers.image.source="https://github.com/Vedant817/Fuse" \
  org.opencontainers.image.revision="${VCS_REF}" \
  org.opencontainers.image.created="${BUILD_DATE}" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
  CONTROL_PLANE_HOST=0.0.0.0 \
  CONTROL_PLANE_PORT=8090

WORKDIR /app

COPY --from=build --chown=node:node /opt/fuse-control-plane/ ./
COPY --from=build --chown=node:node /workspace/LICENSE ./LICENSE

# `pnpm deploy --prod` provides only production dependencies. Remove workspace
# TypeScript sources retained by legacy workspace deployment; compiled output
# and breaker-store SQL migrations remain.
RUN rm -rf /app/src /app/coverage \
  && find -L /app/node_modules/@fuse -mindepth 2 -maxdepth 2 \
    -type d \( -name src -o -name coverage \) -exec rm -rf '{}' +

USER node

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8090/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
