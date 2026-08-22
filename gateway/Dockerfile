# OpenAI Service gateway — multi-stage Node 24 build.

# ── builder ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Install pnpm via corepack.
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# Copy workspace plumbing so pnpm can resolve workspace deps.
COPY pnpm-workspace.yaml package.json ./
COPY gateway/package.json gateway/

# The deployment is a localhost sibling-repository stack. Materialize the
# canonical Modules estimator at the same absolute path targeted by the
# gateway's link: dependency, then give it its own build dependencies.
COPY --from=audio_duration package.json tsconfig.json /livepeer-network-modules/packages/audio-duration/
COPY --from=audio_duration src/ /livepeer-network-modules/packages/audio-duration/src/
RUN pnpm --dir /livepeer-network-modules/packages/audio-duration install --no-frozen-lockfile \
    && pnpm --dir /livepeer-network-modules/packages/audio-duration build

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
# gateway/node_modules contains a link to this absolute sibling path.
COPY --from=builder /livepeer-network-modules/packages/audio-duration/package.json /livepeer-network-modules/packages/audio-duration/package.json
COPY --from=builder /livepeer-network-modules/packages/audio-duration/dist /livepeer-network-modules/packages/audio-duration/dist

WORKDIR /app/gateway

EXPOSE 4001

# Non-root runtime user.
USER 65532:65532

CMD ["node", "./dist/index.js"]
