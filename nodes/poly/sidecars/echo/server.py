# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
import os

from fastapi import FastAPI

app = FastAPI()

BUILD_SHA = os.environ.get("BUILD_SHA", "unknown")


@app.get("/healthz")
def healthz():
    return {"status": "ok", "buildSha": BUILD_SHA}


@app.get("/echo/{msg}")
def echo(msg: str):
    return {"echo": msg}
