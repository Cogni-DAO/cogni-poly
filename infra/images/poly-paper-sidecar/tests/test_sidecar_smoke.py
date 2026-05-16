# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

"""
v0 smoke for poly-paper-sidecar.

Goal: prove the FastAPI ↔ pm_trader.Engine wiring is correct without needing
network access to live Polymarket book reads. We stub `pm_trader.engine.Engine`
with a fake that returns canned dicts, then drive the server's handlers via
fastapi.testclient and assert: place → 200 receipt with status=open, fill loop
flips status → filled, getOrder returns the new status with filled_size_usdc
equal to the placed size_usdc (v0 full-fill assumption).

What this does NOT cover (intentionally — out of scope for v0 build-blocker):

- Real upstream `orderbook.py` fill simulation against a recorded book. The
  fixture-recapture script + real-engine smoke land in a follow-up commit;
  pinning that to CI today would couple us to upstream API stability before
  we've validated the integration end-to-end on candidate-a.
- Polymarket public-API rate behaviour.
- Partial-fill mapping (full-fill assumption is documented invariant for v0).

Anything in the FastAPI mapping layer (`_resolve_slug_or_id`, status mapping,
OrderReceipt projection, lifespan startup, lock acquisition, fill loop
behaviour) is exercised here.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import types
from typing import Any

import pytest

# ─── Stub pm_trader.engine BEFORE importing server.py ───────────────────────

# Fast poll so the test isn't slow.
os.environ.setdefault("PAPER_CHECK_ORDERS_INTERVAL_SECONDS", "0.1")
os.environ.setdefault("PM_TRADER_DATA_DIR", "/tmp/pm_trader-test")
os.environ.setdefault("BUILD_SHA", "test-build")
os.environ.setdefault("UPSTREAM_PAPER_TRADER_SHA", "test-upstream-sha")


class FakeEngine:
    """In-memory stub of `pm_trader.engine.Engine` — just enough surface for
    the sidecar to exercise place / cancel / get / fill-loop semantics."""

    def __init__(self, *, data_dir: Any) -> None:  # signature mirrors upstream
        self._data_dir = data_dir
        self._orders: dict[int, dict[str, Any]] = {}
        self._next_id = 1
        # Markets whose top-of-book is at-or-better than the limit price (per
        # test setup) get filled on the next check_orders tick. Default: empty.
        self.fill_on_next_check: set[int] = set()
        self.init_account_called = False

    def init_account(self, balance: float) -> dict[str, Any]:
        self.init_account_called = True
        return {"balance": balance}

    def place_limit_order(
        self,
        *,
        slug_or_id: str,
        outcome: str,
        side: str,
        amount: float,
        limit_price: float,
        order_type: str = "gtc",
        expires_at: str | None = None,
    ) -> dict[str, Any]:
        oid = self._next_id
        self._next_id += 1
        d = {
            "id": oid,
            "status": "pending",
            "market_slug": slug_or_id,
            "outcome": outcome,
            "side": side,
            "amount": amount,
            "limit_price": limit_price,
            "order_type": order_type,
            "created_at": "2026-05-16T18:00:00+00:00",
            "filled_at": None,
        }
        self._orders[oid] = d
        return d

    def cancel_limit_order(self, order_id: int) -> dict[str, Any] | None:
        d = self._orders.get(order_id)
        if d is None or d["status"] != "pending":
            return None
        d["status"] = "cancelled"
        return d

    def check_orders(self) -> list[dict[str, Any]]:
        filled = []
        for oid in list(self.fill_on_next_check):
            d = self._orders.get(oid)
            if d is None or d["status"] != "pending":
                continue
            d["status"] = "filled"
            d["filled_at"] = "2026-05-16T18:00:30+00:00"
            d["fill_price"] = d["limit_price"]
            filled.append(d)
            self.fill_on_next_check.discard(oid)
        return filled

    def get_pending_orders(self) -> list[dict[str, Any]]:
        return [d for d in self._orders.values() if d["status"] == "pending"]

    def close(self) -> None:
        pass


# Inject the fake module so `from pm_trader.engine import Engine` in server.py
# finds it without needing the real upstream package installed.
_fake_engine_module = types.ModuleType("pm_trader.engine")
_fake_engine_module.Engine = FakeEngine  # type: ignore[attr-defined]
_fake_pm_trader_module = types.ModuleType("pm_trader")
_fake_pm_trader_module.engine = _fake_engine_module  # type: ignore[attr-defined]
sys.modules.setdefault("pm_trader", _fake_pm_trader_module)
sys.modules["pm_trader.engine"] = _fake_engine_module

# Now safe to import the server. Force reimport in case prior tests cached it.
sys.modules.pop("server", None)
import server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client():
    with TestClient(server.app) as c:
        # Replace fresh state per test.
        server.sidecar.orders.clear()
        yield c


# ─── Tests ──────────────────────────────────────────────────────────────────


def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readyz_reports_engine_and_fill_loop(client):
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_version_returns_pinned_shas(client):
    r = client.get("/version")
    assert r.status_code == 200
    body = r.json()
    assert body == {"buildSha": "test-build", "upstreamPaperTraderSha": "test-upstream-sha"}


def test_place_order_returns_open_receipt(client):
    r = client.post(
        "/place-order",
        json={
            "client_order_id": "cogni-coid-1",
            "market_id": "prediction-market:polymarket:0xCONDITION_ID",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 10.0,
            "limit_price": 0.55,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client_order_id"] == "cogni-coid-1"
    assert body["status"] == "open"
    assert body["filled_size_usdc"] == 0
    assert body["order_id"]  # non-empty
    assert body["submitted_at"]


def test_place_order_strips_prefix_and_passes_condition_id(client):
    r = client.post(
        "/place-order",
        json={
            "client_order_id": "cogni-coid-2",
            "market_id": "prediction-market:polymarket:0xABCDEF",
            "outcome": "No",
            "side": "BUY",
            "size_usdc": 5.0,
            "limit_price": 0.4,
        },
    )
    assert r.status_code == 200
    # Look up the stored upstream order to confirm the slug_or_id mapping.
    engine: FakeEngine = server.sidecar.engine  # type: ignore[assignment]
    placed = list(engine._orders.values())[-1]
    assert placed["market_slug"] == "0xABCDEF"
    assert placed["side"] == "buy"  # lowercased before passing upstream


def test_get_order_returns_404_for_unknown_id(client):
    r = client.get("/orders/999999")
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_get_order_returns_receipt_after_place(client):
    r = client.post(
        "/place-order",
        json={
            "client_order_id": "cogni-coid-3",
            "market_id": "prediction-market:polymarket:0xCID",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 3.0,
            "limit_price": 0.5,
        },
    )
    oid = r.json()["order_id"]
    r2 = client.get(f"/orders/{oid}")
    assert r2.status_code == 200
    body = r2.json()
    assert body["status"] == "open"
    assert body["client_order_id"] == "cogni-coid-3"
    assert body["filled_size_usdc"] == 0


def test_fill_loop_flips_status_and_populates_filled_size(client):
    r = client.post(
        "/place-order",
        json={
            "client_order_id": "cogni-coid-4",
            "market_id": "prediction-market:polymarket:0xFILLME",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 7.0,
            "limit_price": 0.6,
        },
    )
    oid = r.json()["order_id"]
    # Tell the fake engine to fill this order on the next check.
    engine: FakeEngine = server.sidecar.engine  # type: ignore[assignment]
    engine.fill_on_next_check.add(int(oid))

    # Background fill loop runs every 0.1s (test env). Poll the receipt up to 2s.
    deadline = time.time() + 2.0
    while time.time() < deadline:
        r2 = client.get(f"/orders/{oid}")
        if r2.json().get("status") == "filled":
            break
        time.sleep(0.05)

    body = r2.json()
    assert body["status"] == "filled", f"never filled; final body={body}"
    # v0 full-fill assumption: realized = intent.
    assert body["filled_size_usdc"] == 7.0


def test_cancel_unknown_id_returns_404(client):
    r = client.post("/orders/999999/cancel")
    assert r.status_code == 404


def test_cancel_existing_order_returns_204_and_flips_status(client):
    r = client.post(
        "/place-order",
        json={
            "client_order_id": "cogni-coid-5",
            "market_id": "prediction-market:polymarket:0xCNX",
            "outcome": "Yes",
            "side": "BUY",
            "size_usdc": 4.0,
            "limit_price": 0.5,
        },
    )
    oid = r.json()["order_id"]
    r2 = client.post(f"/orders/{oid}/cancel")
    assert r2.status_code == 204
    r3 = client.get(f"/orders/{oid}")
    assert r3.json()["status"] == "cancelled"


def test_cancel_invalid_id_format_returns_404(client):
    r = client.post("/orders/not-an-int/cancel")
    assert r.status_code == 404


def test_lock_serializes_engine_calls(client):
    """Smoke that the global lock prevents concurrent engine entry.

    We can't easily assert "only one thread inside engine at a time" without
    instrumenting the engine — instead we drive 20 parallel place_order POSTs
    through the testclient's threadpool and assert all succeed with distinct
    upstream ids. A broken lock would race the fake engine's _next_id counter
    and produce dupes."""
    results = []
    lock = threading.Lock()

    def _place(i: int):
        r = client.post(
            "/place-order",
            json={
                "client_order_id": f"parallel-{i}",
                "market_id": "prediction-market:polymarket:0xPAR",
                "outcome": "Yes",
                "side": "BUY",
                "size_usdc": 1.0,
                "limit_price": 0.5,
            },
        )
        with lock:
            results.append(r.json()["order_id"])

    threads = [threading.Thread(target=_place, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 20
    assert len(set(results)) == 20, f"duplicate order_ids: {sorted(results)}"
