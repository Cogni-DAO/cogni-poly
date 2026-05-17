# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# poly-test-worker — Catalog v2 Shape A e2e exercise.
# Standalone build (no @cogni/* workspace deps) so the Dockerfile minimum
# surface stays small. tsup bundles all runtime deps into dist/main.js;
# the runner only needs Node.
#
# Multi-stage so the runner image carries no build toolchain.

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.2 --activate

FROM base AS builder
COPY services/poly-test-worker/package.json services/poly-test-worker/tsconfig.json services/poly-test-worker/tsup.config.ts ./
RUN pnpm install --ignore-scripts --no-frozen-lockfile
COPY services/poly-test-worker/src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS runner
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker
USER worker

WORKDIR /app
COPY --from=builder --chown=worker:nodejs /app/dist ./dist

ENV NODE_ENV=production

ARG BUILD_SHA=unknown
ARG BUILD_TS=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TS=${BUILD_TS}

CMD ["node", "dist/main.js"]
