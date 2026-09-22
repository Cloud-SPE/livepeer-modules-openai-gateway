# OpenAI Service gateway — multi-stage Node build.

ARG NODE_VERSION=24

# ── builder ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder

ARG PNPM_VERSION=10.0.0

WORKDIR /app

# Install pnpm via corepack.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy workspace plumbing so pnpm can resolve workspace deps.
COPY pnpm-workspace.yaml package.json ./
COPY gateway/package.json gateway/

# Install only the gateway's deps (workspace-scoped, frozen lockfile).
# Lockfile must be at repo root when present.
COPY pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --filter @livepeer-modules-openai/gateway...

# Build the gateway.
COPY gateway/ gateway/
COPY web/ web/
RUN pnpm --filter @livepeer-modules-openai/gateway build

# ── runtime ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG APP_VERSION=2.0.0
ARG BUILD_VERSION=dev
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="Livepeer Modules OpenAI Gateway" \
      org.opencontainers.image.description="OpenAI-compatible gateway backed by Livepeer paid-job/v1" \
      org.opencontainers.image.source="https://github.com/Cloud-SPE/livepeer-modules-openai-gateway" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.ref.name="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

# Reasonable defaults; everything else comes from env at deploy time.
ENV NODE_ENV=production \
    PORT=4001

WORKDIR /app

# Copy the production node_modules and built JS only.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/gateway/node_modules ./gateway/node_modules
COPY --from=builder /app/gateway/dist ./gateway/dist
COPY --from=builder /app/gateway/migrations ./gateway/migrations
COPY --from=builder /app/gateway/package.json ./gateway/package.json
COPY --from=builder /app/web ./web

WORKDIR /app/gateway

EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Non-root runtime user.
USER 65532:65532

CMD ["node", "./dist/index.js"]
