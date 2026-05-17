# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# poly-test-worker — Catalog v2 Shape A canonical reference.
# Standalone build (no @cogni/* workspace deps). Two-stage:
#   1. builder: pnpm install + pnpm build → transpiled dist/ + real node_modules
#   2. runner:  copy dist/ + node_modules/ + package.json — node loads runtime
#               deps from real disk (pino, thread-stream workers, etc.).
#
# Why not single-stage tsup bundle: pino does `require('os')` and spawns
# worker threads at runtime. ESM bundling forbids dynamic require → pod
# crashes on first import. The transpile-only + copy-node_modules path is
# the canonical Node.js pattern and matches services/scheduler-worker/.

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.2 --activate

FROM base AS builder
COPY services/poly-test-worker/package.json services/poly-test-worker/tsconfig.json services/poly-test-worker/tsup.config.ts ./
RUN pnpm install --ignore-scripts --no-frozen-lockfile
COPY services/poly-test-worker/src ./src
RUN pnpm build
# Prune dev deps so the runner image only carries runtime tree.
RUN pnpm prune --prod --ignore-scripts

FROM node:22-bookworm-slim AS runner
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker
USER worker

WORKDIR /app
COPY --from=builder --chown=worker:nodejs /app/dist ./dist
COPY --from=builder --chown=worker:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=worker:nodejs /app/package.json ./package.json

ENV NODE_ENV=production

ARG BUILD_SHA=unknown
ARG BUILD_TS=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TS=${BUILD_TS}

CMD ["node", "dist/main.js"]
