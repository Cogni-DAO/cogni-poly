# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# infratest-shape-a - temporary infra-test mirror of poly-test-worker.
# Validates docs/guides/create-service.md end-to-end after task.5006 (image-
# native build-provenance via OCI labels). Standalone two-stage build:
#   1. builder: pnpm install + pnpm build -> transpiled dist/ + real node_modules
#   2. runner:  copy dist/ + node_modules/ + package.json
# Will be rolled back in a follow-up PR after candidate-a validation.

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.2 --activate

FROM base AS builder
COPY services/infratest-shape-a/package.json services/infratest-shape-a/tsconfig.json services/infratest-shape-a/tsup.config.ts ./
RUN pnpm install --ignore-scripts --no-frozen-lockfile
COPY services/infratest-shape-a/src ./src
RUN pnpm build
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
