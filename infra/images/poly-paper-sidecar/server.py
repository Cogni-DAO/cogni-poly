# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""
poly-paper-sidecar — HTTP transport between the TS PaperAdapter and the
agent-next/polymarket-paper-trader fill engine.

v0 of this server is a placeholder. The /healthz endpoint reports OK so
liveness probes pass in candidate-a + preview; Run-phase endpoints return
501 with a clear message so any accidental call surfaces in Loki as
"paper sidecar place-order failed: 501". The actual fill-engine wiring
lands in the proj.poly-paper-trading task.6 follow-up.

This file deliberately contains NO fill logic — that lives upstream in
agent-next/polymarket-paper-trader (MIT). When the follow-up lands, it
will import from the pinned upstream package and translate between this
HTTP contract and the upstream engine's API.

The TS adapter's contract this server fulfils (Run-phase, not yet wired):
  POST /place-order                  body=OrderIntent fields → OrderReceipt
  POST /orders/{order_id}/cancel     204 success, 404 idempotent
  GET  /orders/{order_id}            200 OrderReceipt | 404 not_found
"""

from fastapi import FastAPI, HTTPException

app = FastAPI(title="poly-paper-sidecar", version="0.0.1-placeholder")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe target. Always reports OK while the server is up."""
    return {"status": "ok", "version": "0.0.1-placeholder"}


@app.post("/place-order")
def place_order(_body: dict) -> dict:
    raise HTTPException(
        status_code=501,
        detail=(
            "paper sidecar v0 placeholder — fill-engine wiring lands in "
            "proj.poly-paper-trading task.6 follow-up. PaperAdapter callers "
            "will see this as a clean error until then."
        ),
    )


@app.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str) -> dict:
    raise HTTPException(status_code=501, detail=f"placeholder cancel for {order_id}")


@app.get("/orders/{order_id}")
def get_order(order_id: str) -> dict:
    # 404 is the explicit "not_found" branch in the TS adapter's
    # GetOrderResult discriminated union (PAPER_GETORDER_NEVER_NULL).
    raise HTTPException(status_code=404, detail=f"no order {order_id}")
