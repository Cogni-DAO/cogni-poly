# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# poly-paper-sidecar — Python sidecar wrapping agent-next/polymarket-paper-trader
# (MIT) behind an HTTP API that the TS PaperAdapter speaks to.
#
# Architecture:
#   TS PaperAdapter (loopback HTTP) → this sidecar (FastAPI) → agent-next library.
#
# Contract the TS adapter expects (nodes/poly/packages/market-provider/src/adapters/paper/):
#   POST /place-order                  — body: typed OrderIntent fields → OrderReceipt
#   POST /orders/{order_id}/cancel     — 204 on cancel, 404 idempotent
#   GET  /orders/{order_id}            — 200 OrderReceipt | 404 not_found
#
# The fill model itself lives entirely in the pinned upstream commit — this image
# only provides transport + Zod-compatible response shaping. Per the project's
# strict OSS-only constraint, do NOT add fill logic here; if a Polymarket fee
# rule or matching behaviour is wrong, file upstream + bump UPSTREAM_PAPER_TRADER_SHA.
#
# TODO(proj.poly-paper-trading task.6 follow-up): the FastAPI wrapper that maps
# the HTTP contract above onto agent-next's `orderbook.py` + `engine.py` lives
# in a follow-up commit. v0 of this image is a placeholder that returns 501 on
# Run-phase endpoints so the deployment shape can ship + be validated
# independently. Paper-mode targets in production will surface a clear
# `paper sidecar place-order failed: 501` error in Loki until the wrapper lands.

FROM python:3.12-slim AS base

WORKDIR /app

# Pinned upstream commit. Bump after auditing the diff (especially the fee
# formula `bps/10000 × min(p, 1-p) × shares` — drift here is the highest-
# fidelity-impact change agent-next can make).
ARG UPSTREAM_PAPER_TRADER_SHA=main
ENV UPSTREAM_PAPER_TRADER_SHA=${UPSTREAM_PAPER_TRADER_SHA}

# Minimal runtime deps. FastAPI + uvicorn for the HTTP transport, httpx for
# upstream-library HTTP calls (Polymarket book reads). agent-next/polymarket-
# paper-trader gets installed from GitHub at the pinned SHA in the follow-up.
RUN pip install --no-cache-dir \
  "fastapi>=0.115,<0.116" \
  "uvicorn[standard]>=0.32,<0.33" \
  "httpx>=0.27" \
  "pydantic>=2.9,<3"

COPY server.py /app/server.py

EXPOSE 9100

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9100"]
