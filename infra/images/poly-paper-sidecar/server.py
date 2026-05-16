# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""
poly-paper-sidecar v0 — FastAPI wrapper over agent-next/polymarket-paper-trader.

Contract (consumed by the cogni TS PaperAdapter at
`@cogni/poly-market-provider/adapters/paper`):

  GET  /healthz                       — liveness (process up)
  GET  /readyz                        — readiness (fill loop alive)
  GET  /version                       — { buildSha, upstreamPaperTraderSha }
  POST /place-order                   — PlaceOrderRequest → OrderReceipt
  POST /orders/{order_id}/cancel      — 204 on cancel, 404 idempotent
  GET  /orders/{order_id}             — 200 OrderReceipt | 404 not_found

Design (see work/projects/proj.poly-paper-trading.md § "Design — PR 3"):

- One Engine per pod, instantiated at lifespan startup.
- A single `threading.Lock` guards every Engine call. Background fill-poll
  thread acquires the same lock — there are no concurrent Engine calls.
- FastAPI handlers are sync `def` (not `async def`) so they run in FastAPI's
  internal threadpool — no `asyncio.to_thread` plumbing needed.
- In-memory `OrderState` map keyed by upstream order id holds enough to map
  back to the cogni `OrderReceipt` shape (including the client_order_id we
  need to echo back). Pod restart wipes this — by design for v0; the cogni
  reconciler treats orphan pending rows the same as a CLOB outage would.
- v0 fill-amount approximation: full fill is assumed when upstream reports
  `status="filled"`. `filled_size_usdc = intent.size_usdc`. Partial fills
  aren't surfaced separately (rare under copy-trade cap sizes). Documented
  invariant; future PR can lift exact realized cost/fee from the upstream
  dict if the upstream stabilizes those keys.

This file deliberately writes NO fill logic. All matching, fee math, and
book-walk happens inside `pm_trader.Engine`. If upstream is wrong, file
upstream and bump `UPSTREAM_PAPER_TRADER_SHA`.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional

# SQLite default: a connection can only be used in the thread that created it.
# pm_trader.Engine opens its SQLite connection in its constructor (called on
# the lifespan thread), but our handlers run on FastAPI's threadpool and the
# fill loop runs on a daemon thread — all different from the lifespan thread.
# The global asyncio.Lock^W threading.Lock in Sidecar already serialises every
# Engine call, so the "unsafe cross-thread" SQLite condition isn't actually
# concurrent. Monkey-patch sqlite3.connect to disable the thread-affinity
# check BEFORE pm_trader is imported so the engine's connection allows
# cross-thread use under our lock. SQLite WAL handles file-level consistency.
_orig_sqlite_connect = sqlite3.connect


def _connect_no_thread_check(*args: Any, **kwargs: Any) -> sqlite3.Connection:
    kwargs.setdefault("check_same_thread", False)
    return _orig_sqlite_connect(*args, **kwargs)


sqlite3.connect = _connect_no_thread_check  # type: ignore[assignment]

from fastapi import FastAPI, HTTPException, Response  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

# ─── Config (env-driven; defaults sourced from Dockerfile ENV) ──────────────

DATA_DIR = Path(os.environ.get("PM_TRADER_DATA_DIR", "/tmp/pm_trader"))
ACCOUNT = os.environ.get("PM_TRADER_ACCOUNT", "cogni-paper")
STARTING_BALANCE_USDC = float(
    os.environ.get("PM_TRADER_STARTING_BALANCE_USDC", "1000000")
)
CHECK_ORDERS_INTERVAL_SECONDS = float(
    os.environ.get("PAPER_CHECK_ORDERS_INTERVAL_SECONDS", "30")
)
BUILD_SHA = os.environ.get("BUILD_SHA", "unknown")
UPSTREAM_PAPER_TRADER_SHA = os.environ.get("UPSTREAM_PAPER_TRADER_SHA", "unknown")

# Cogni `market_id` is `"prediction-market:polymarket:<conditionId>"`
# (nodes/poly/packages/market-provider/src/adapters/polymarket/polymarket.normalize-fill.ts:79).
# Upstream `Engine.place_limit_order(slug_or_id, ...)` accepts a Polymarket slug
# OR conditionId. We strip the cogni prefix and pass the bare conditionId.
MARKET_ID_PREFIX = "prediction-market:polymarket:"

# Upstream LimitOrder.status (from pm_trader.orders) maps to cogni's OrderStatus.
# Cogni `OrderStatus` enum: open|filled|cancelled|expired (we collapse expired
# into cancelled — the reconciler treats them identically).
UPSTREAM_TO_COGNI_STATUS = {
    "pending": "open",
    "filled": "filled",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "expired": "cancelled",
}

# ─── Structured logging — JSON to stdout for Alloy → Loki pickup ────────────
# Shape: { ts, level, msg, logger, [event, client_order_id, order_id, ...] }
# Cogni Pino logs use the same client_order_id field — joins in Grafana.
logging.basicConfig(
    level=os.environ.get("PINO_LOG_LEVEL", "info").upper(),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("poly-paper-sidecar")


# ─── Wire schemas (Pydantic) ────────────────────────────────────────────────


class PlaceOrderRequest(BaseModel):
    """Mirrors `PlaceOrderRequestSchema` in nodes/poly/packages/market-provider/
    src/adapters/paper/paper.adapter.ts:80."""

    client_order_id: str = Field(..., min_length=1)
    market_id: str = Field(..., min_length=1)
    token_id: Optional[str] = None
    outcome: str = Field(..., min_length=1)
    side: str  # "BUY" | "SELL"
    size_usdc: float = Field(..., gt=0)
    limit_price: float = Field(..., gt=0)
    attributes: Optional[dict[str, Any]] = None


class OrderReceipt(BaseModel):
    """Mirrors `OrderReceiptSchema` in nodes/poly/packages/market-provider/
    src/domain/order.ts:134."""

    order_id: str
    client_order_id: str
    status: str
    filled_size_usdc: float
    submitted_at: str
    attributes: Optional[dict[str, Any]] = None


# ─── Per-order in-memory shadow state ───────────────────────────────────────


class OrderState:
    """Everything we need to construct an `OrderReceipt` from an order id.

    The upstream Engine doesn't track our `client_order_id` — we keep the
    mapping here. Volatile by design (pod restart wipes); the cogni reconciler
    closes orphan pending rows after its grace window.
    """

    __slots__ = (
        "upstream_id",
        "client_order_id",
        "intent_size_usdc",
        "status",
        "filled_size_usdc",
        "submitted_at",
        "extra",
    )

    def __init__(
        self,
        *,
        upstream_id: str,
        client_order_id: str,
        intent_size_usdc: float,
        status: str,
        filled_size_usdc: float,
        submitted_at: str,
        extra: dict[str, Any],
    ) -> None:
        self.upstream_id = upstream_id
        self.client_order_id = client_order_id
        self.intent_size_usdc = intent_size_usdc
        self.status = status
        self.filled_size_usdc = filled_size_usdc
        self.submitted_at = submitted_at
        self.extra = extra


def _to_receipt(st: OrderState) -> OrderReceipt:
    return OrderReceipt(
        order_id=st.upstream_id,
        client_order_id=st.client_order_id,
        status=st.status,
        filled_size_usdc=st.filled_size_usdc,
        submitted_at=st.submitted_at,
        attributes={
            "upstream_status": st.extra.get("status"),
            "upstream_id": st.upstream_id,
        },
    )


def _resolve_slug_or_id(req: PlaceOrderRequest) -> str:
    """Map cogni `market_id` → upstream `slug_or_id` (conditionId or slug)."""
    if req.market_id.startswith(MARKET_ID_PREFIX):
        return req.market_id[len(MARKET_ID_PREFIX) :]
    if req.attributes and isinstance(req.attributes.get("condition_id"), str):
        return req.attributes["condition_id"]
    # Last resort — pass through verbatim. Upstream will 4xx if it can't resolve.
    return req.market_id


# ─── Sidecar — wraps Engine + lifespan + lock + fill loop ───────────────────


class Sidecar:
    def __init__(self) -> None:
        self.engine: Optional[Any] = None  # pm_trader.engine.Engine
        self.lock = threading.Lock()
        self.orders: dict[str, OrderState] = {}
        self._fill_thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        from pm_trader.engine import Engine

        # Reset stop flag so a restarted lifespan (e.g. across tests) gets a
        # fresh thread that doesn't see a stale set-event and exit immediately.
        self._stop.clear()

        account_dir = DATA_DIR / ACCOUNT
        account_dir.mkdir(parents=True, exist_ok=True)
        self.engine = Engine(data_dir=account_dir)
        # Idempotent — already-initialized accounts re-init harmlessly OR raise;
        # we accept either and move on.
        try:
            self.engine.init_account(balance=STARTING_BALANCE_USDC)
        except Exception as e:
            log.info(
                f'event=account_init_skipped reason="{e}" account={ACCOUNT}'
            )

        self._fill_thread = threading.Thread(
            target=self._fill_loop, daemon=True, name="paper-fill-loop"
        )
        self._fill_thread.start()
        log.info(
            f"event=sidecar_started account={ACCOUNT} data_dir={account_dir} "
            f"check_interval_s={CHECK_ORDERS_INTERVAL_SECONDS} "
            f"upstream_sha={UPSTREAM_PAPER_TRADER_SHA[:8]}"
        )

    def stop(self) -> None:
        self._stop.set()
        if self._fill_thread and self._fill_thread.is_alive():
            self._fill_thread.join(timeout=5)
        if self.engine is not None:
            try:
                self.engine.close()
            except Exception:
                pass

    def _fill_loop(self) -> None:
        """Polls `engine.check_orders()` on a fixed interval. Without this,
        resting paper limits never transition to filled."""
        while not self._stop.wait(CHECK_ORDERS_INTERVAL_SECONDS):
            try:
                with self.lock:
                    filled = self.engine.check_orders()  # type: ignore[union-attr]
                if not filled:
                    continue
                for d in filled:
                    oid = str(d.get("id", ""))
                    st = self.orders.get(oid)
                    if st is None:
                        continue
                    st.status = "filled"
                    # v0 full-fill assumption: realized notional = intended.
                    # Partial-fill fidelity lifts in a later PR if upstream
                    # stabilizes realized-cost/fee keys on the check_orders dict.
                    st.filled_size_usdc = st.intent_size_usdc
                    st.extra.update(d)
                    log.info(
                        f"event=order_filled order_id={oid} "
                        f'client_order_id={st.client_order_id} '
                        f"filled_size_usdc={st.filled_size_usdc}"
                    )
            except Exception as e:
                log.exception(f"event=check_orders_failed err={e}")

    # ── handlers ───────────────────────────────────────────────────────────

    def place(self, req: PlaceOrderRequest) -> OrderReceipt:
        slug_or_id = _resolve_slug_or_id(req)
        with self.lock:
            try:
                d: dict[str, Any] = self.engine.place_limit_order(  # type: ignore[union-attr]
                    slug_or_id=slug_or_id,
                    outcome=req.outcome,
                    side=req.side.lower(),
                    amount=req.size_usdc,
                    limit_price=req.limit_price,
                    order_type="gtc",
                )
            except Exception as e:
                log.exception(
                    f"event=place_failed client_order_id={req.client_order_id} err={e}"
                )
                raise HTTPException(
                    status_code=502, detail=f"upstream place_limit_order failed: {e}"
                )

        upstream_id = d.get("id")
        if upstream_id is None:
            raise HTTPException(
                status_code=502,
                detail=f"upstream returned no order id: keys={list(d.keys())}",
            )
        oid = str(upstream_id)

        upstream_status = str(d.get("status", "pending")).lower()
        cogni_status = UPSTREAM_TO_COGNI_STATUS.get(upstream_status, "open")
        submitted_at = (
            d.get("created_at")
            or datetime.now(timezone.utc).isoformat(timespec="seconds")
        )

        st = OrderState(
            upstream_id=oid,
            client_order_id=req.client_order_id,
            intent_size_usdc=req.size_usdc,
            status=cogni_status,
            filled_size_usdc=req.size_usdc if cogni_status == "filled" else 0.0,
            submitted_at=str(submitted_at),
            extra=d,
        )
        self.orders[oid] = st
        log.info(
            f"event=order_placed order_id={oid} client_order_id={req.client_order_id} "
            f'status={cogni_status} slug_or_id="{slug_or_id}" outcome="{req.outcome}" '
            f"side={req.side} size_usdc={req.size_usdc} limit_price={req.limit_price}"
        )
        return _to_receipt(st)

    def cancel(self, order_id: str) -> None:
        try:
            int_id = int(order_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="not_found")

        with self.lock:
            try:
                result = self.engine.cancel_limit_order(int_id)  # type: ignore[union-attr]
            except Exception as e:
                log.exception(f"event=cancel_failed order_id={order_id} err={e}")
                raise HTTPException(
                    status_code=502, detail=f"upstream cancel failed: {e}"
                )
        if result is None:
            raise HTTPException(status_code=404, detail="not_found")
        st = self.orders.get(order_id)
        if st is not None:
            st.status = "cancelled"
        log.info(f"event=order_cancelled order_id={order_id}")

    def get(self, order_id: str) -> OrderReceipt:
        st = self.orders.get(order_id)
        if st is None:
            raise HTTPException(status_code=404, detail="not_found")
        return _to_receipt(st)


sidecar = Sidecar()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    sidecar.start()
    try:
        yield
    finally:
        sidecar.stop()


app = FastAPI(title="poly-paper-sidecar", version="1.0.0", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    if sidecar._fill_thread is None or not sidecar._fill_thread.is_alive():
        raise HTTPException(status_code=503, detail="fill_loop_not_running")
    if sidecar.engine is None:
        raise HTTPException(status_code=503, detail="engine_not_initialized")
    return {"status": "ok"}


@app.get("/version")
def version() -> dict[str, str]:
    return {
        "buildSha": BUILD_SHA,
        "upstreamPaperTraderSha": UPSTREAM_PAPER_TRADER_SHA,
    }


@app.post("/place-order")
def place_order(req: PlaceOrderRequest) -> OrderReceipt:
    return sidecar.place(req)


@app.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str) -> Response:
    sidecar.cancel(order_id)
    return Response(status_code=204)


@app.get("/orders/{order_id}")
def get_order(order_id: str) -> OrderReceipt:
    return sidecar.get(order_id)
