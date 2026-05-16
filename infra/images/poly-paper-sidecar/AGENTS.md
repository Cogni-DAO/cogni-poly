# poly-paper-sidecar · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Python sidecar container that wraps [`agent-next/polymarket-paper-trader`](https://github.com/agent-next/polymarket-paper-trader) (MIT) behind an HTTP API. The TS `PaperAdapter` in `@cogni/poly-market-provider/adapters/paper` speaks HTTP to this sidecar over pod-loopback. Together they implement the paper-trading backend used by `mode='paper'` copy-trade targets and the always-paper `candidate-a` / `preview` overlays.

## Pointers

- [Project](../../../work/projects/proj.poly-paper-trading.md)
- [Research](../../../docs/research/poly-paper-trading-mode.md)
- [TS adapter](../../../nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts)

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

**External deps:** `agent-next/polymarket-paper-trader` (MIT, pinned commit), `fastapi`, `uvicorn`, `httpx`, `pydantic`.

## Public Surface

- `Dockerfile` — builds the sidecar image; `UPSTREAM_PAPER_TRADER_SHA` is the pin point for the agent-next commit.
- `server.py` — FastAPI app exposing `GET /healthz`, `POST /place-order`, `GET /orders/{id}`, `POST /orders/{id}/cancel`. v0 placeholder.

## HTTP contract (consumed by `PaperAdapter`)

| Method + Path                    | Purpose                    | Success        | Error                            |
| -------------------------------- | -------------------------- | -------------- | -------------------------------- |
| `GET /healthz`                   | Liveness probe             | `200 {status}` | —                                |
| `POST /place-order`              | Submit a paper limit order | `200 receipt`  | `5xx` / `4xx` per upstream cause |
| `POST /orders/{order_id}/cancel` | Idempotent cancel          | `204`          | `404` swallowed by adapter       |
| `GET /orders/{order_id}`         | Status lookup              | `200 receipt`  | `404` → `not_found` in adapter   |

Response shape on `200`: matches `OrderReceiptSchema` from `@cogni/poly-market-provider`. `filled_size_usdc` MUST reflect realised fill amount (PAPER_POPULATES_FILLED_USDC) — without it, the TS-side cap accounting (`CAP_COUNTS_REALIZED_ON_CANCEL`) drifts.

## v0 status

- `server.py` is a placeholder. `/healthz` returns OK; Run-phase endpoints return 501 / 404. This ships the architecture without functional paper trading — the actual upstream-engine wiring lands in a follow-up commit.
- In the candidate-a and preview overlays (where `PAPER_ENFORCE_MODE=paper` is set in PR 2), this means every mirror placement attempt will emit a clean `paper sidecar place-order failed: 501` error in Loki. That's the intended signal — the deployment is paper-enforced; no real money can be spent; the only thing missing is the upstream-engine glue.

## Responsibilities

- This directory **does**: build a Python sidecar image; expose the HTTP contract above; pin the upstream `agent-next/polymarket-paper-trader` commit SHA.
- This directory **does not**: implement fill logic, fee math, queue-position modelling, or any other simulation behaviour. All of that is upstream property — if it's wrong, file upstream and bump `UPSTREAM_PAPER_TRADER_SHA`. (This is the "we write no fill logic" constraint from `proj.poly-paper-trading`.)

## Bumping the upstream pin

1. Audit the upstream diff — focus on `orderbook.py`, `engine.py`, and the fee formula (`bps/10000 × min(p, 1-p) × shares`).
2. Update `UPSTREAM_PAPER_TRADER_SHA` in the `Dockerfile` build arg.
3. Build + push the new image.
4. Run the (forthcoming) CI fee-drift smoke test against a known fixture.

## Notes

- v0 ships a placeholder server so the deployment shape can land independently of the upstream-engine glue. The architecture is in place; functional paper trading arrives when the FastAPI wrapper maps `agent-next/polymarket-paper-trader`'s `orderbook.py` + `engine.py` onto our HTTP contract.
- This image is consumed only as a pod-loopback sidecar. It must never be exposed to a Service or Ingress — `PaperAdapter`'s base URL defaults to `http://localhost:9100` and is only constructor-injected, never DNS-resolved.
