# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# poly-paper-sidecar — Python sidecar wrapping agent-next/polymarket-paper-trader
# (MIT) behind an HTTP API. The TS PaperAdapter speaks to it over pod-loopback.
#
# Pin: agent-next/polymarket-paper-trader v0.1.6 (commit 8a0a3ee2, 2026-03-01).
# Bump checklist in AGENTS.md — re-bless the smoke fixture on every bump.

FROM python:3.12-slim AS base

WORKDIR /app

ARG UPSTREAM_PAPER_TRADER_SHA=8a0a3ee265cfd375c172626b0c63be72c07beaee
ENV UPSTREAM_PAPER_TRADER_SHA=${UPSTREAM_PAPER_TRADER_SHA}
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

# git needed to pip-install upstream from a pinned commit.
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
  "fastapi>=0.115,<0.116" \
  "uvicorn[standard]>=0.32,<0.33" \
  "pydantic>=2.9,<3" \
  "git+https://github.com/agent-next/polymarket-paper-trader@${UPSTREAM_PAPER_TRADER_SHA}"

COPY server.py /app/server.py

# Default writable data dir under /tmp (compatible with readOnlyRootFilesystem).
ENV PM_TRADER_DATA_DIR=/tmp/pm_trader
ENV PM_TRADER_ACCOUNT=cogni-paper
ENV PM_TRADER_STARTING_BALANCE_USDC=1000000
ENV PAPER_CHECK_ORDERS_INTERVAL_SECONDS=30
ENV PINO_LOG_LEVEL=info

EXPOSE 9100

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9100"]

# ---- test stage: runs pytest against server.py under a stubbed PolymarketClient.
# The CI workflow targets this stage with --target=test as a build-blocker.
FROM base AS test

RUN pip install --no-cache-dir "pytest>=8" "httpx>=0.27"

COPY tests /app/tests

# Test env mirrors prod env shape; data dir under /tmp/test to avoid clobbering.
ENV PM_TRADER_DATA_DIR=/tmp/pm_trader-test
ENV PAPER_CHECK_ORDERS_INTERVAL_SECONDS=0.1

RUN pytest -q /app/tests
