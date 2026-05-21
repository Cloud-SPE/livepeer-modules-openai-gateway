# OpenAI Service gateway — multi-stage Node 24 build.

# ── builder ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Install pnpm via corepack.
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

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
FROM node:24-bookworm-slim AS runtime

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

# Protos are loaded at runtime; ship them.
COPY proto/ ./proto/

WORKDIR /app/gateway

EXPOSE 4001

# Run as the same non-root uid/gid the daemon images use so the gateway can
# open their shared Unix sockets.
USER 65532:65532

CMD ["node", "./dist/index.js"]
