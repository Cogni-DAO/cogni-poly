# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# poly-echo-sidecar — Catalog v2 e2e exercise sidecar. Minimal HTTP server
# that returns 200 on /healthz and echoes back on /echo/<msg>. Exists to
# prove "add a new sidecar = 1 catalog entry + 1 source dir (incl. k8s
# Component) + 1 `components:` line per overlay where active". Zero inline
# container patches in host overlays.

FROM python:3.12-slim AS base

WORKDIR /app

ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

RUN pip install --no-cache-dir \
  "fastapi>=0.115,<0.116" \
  "uvicorn[standard]>=0.32,<0.33"

COPY server.py /app/server.py

EXPOSE 9101

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9101"]
