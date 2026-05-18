---
id: bug.5060.handoff
type: handoff
title: "paper-trader sidecar (pm_trader) under-fills ~80% vs live CLOB"
work_item: bug.5060
project: proj.poly-paper-trading
created: 2026-05-18
author: claude (via tenant-matrix-evaluator investigation, PR #100)
severity: critical
blocks:
  - /tenant-matrix-evaluator (fidelity readings reflect engine bug, not planner)
  - /paper-trade-diff-analysis (same)
  - all D2-phase-2 A/B promotion decisions
---

# bug.5060 — paper engine under-fills vs live by ~80%

## TL;DR

`poly-paper-sidecar` runs the OSS `pm_trader` engine. Over the last 24h on preview's trust-twin tenant (same swisstony config as prod), paper filled **$50** while prod live filled **$267** — **18.9% fidelity**. Spec docs the ceiling at 96-98% under limit-only. Reality is 19%.

The pod is **healthy** — not crashed, not OOM. The fill loop is ticking every ~30s and reporting `pending_count: 22, filled_count: 0` on every tick. **0 `order_filled` events in 3h of Loki history.** Orders rest until reconciler-TTL cancels them; status becomes `canceled`; `filled_size_usdc` stays 0.

Every paper-trading decision in the matrix is reading this engine bug, not the planner. Until paper tracks live within ±5%, every algo-promotion conversation is invalid.

## Evidence

### Cumulative $ filled (preview trust-twin, 24h, hourly buckets)

```
05-17 19:00Z   $8.36     (twin alive, filling)
05-17 20:00Z   $49.33    ← jumped on a placement burst
05-17 21:00Z   $50.33    ← last fill ever
05-17 22:00Z → $50.33    (flat for 20+ hours)
... through 05-18 17:00Z $50.33
```

vs prod LIVE same window: $70 → $266 (linear growth, +$8-30/hr).

### Twin's fills-table status distribution after 22:00Z

| status   | count since 22:00Z | cancel_reason | err_code |
| -------- | ------------------ | ------------- | -------- |
| canceled | 233                | `null`        | `null`   |
| error    | 36                 | `null`        | `null`   |
| filled   | **0**              | —             | —        |

Twin's _planner_ is still firing 10-37 placements/hr — the planner is fine. The **executor (paper sidecar)** silently fails every placement.

### Loki signature (last ~3h, current Grafana Cloud retention)

```
event                                              count
adapter.paper_sidecar.place_order.complete         71
adapter.paper_sidecar.cancel_order.complete        29
adapter.paper_sidecar.order_filled                  0   ← THIS
adapter.paper_sidecar.fill_loop.tick_complete      30   (each shows filled_count: 0)
adapter.paper_sidecar.fill_loop.error               0
```

Sample tick line:

```json
{
  "event": "adapter.paper_sidecar.fill_loop.tick_complete",
  "pending_count": 22,
  "filled_count": 0
}
```

The fill loop sees 22 pending orders, decides 0 should fill, repeats.

### What's NOT broken (ruled out)

- ❌ Pod crashed / OOMKilled — pod is `poly-node-app-7d4dd986dc-ggt4n`, alive, healthz returns 200
- ❌ Fill loop deadlocked — ticks every ~30s on schedule
- ❌ DB / fills ledger broken — rows are landing with correct shape; just `filled_size_usdc=0`
- ❌ Planner divergence — twin's `decisions` rows show same outcome distribution as live's (within 3%)
- ❌ Resource cap — 384Mi memory limit is fine for 22 pending orders + small JSON state
- ❌ Polymarket CLOB API down — live LIVE tenant filled $266 in the same window

## Hypothesis (where to look)

**Primary**: the `pm_trader` queue model requires the resting limit price to be **at or better than the BBO** (top-of-book) on the polled `clob.polymarket.com/book?token_id=...` response. Live CLOB matches deeper into the book — if a taker order sweeps multiple price levels, our limit can fill at our price even though it's worse than the BBO at the moment of placement.

So when our planner places `BUY @ 0.42` and the live book has `bid=0.40 ask=0.45`:

- **Live CLOB**: a taker `SELL` at any price ≤ 0.42 will match us. We fill.
- **`pm_trader`**: our 0.42 < ask 0.45, so we sit at-or-below BBO; the engine never moves us into "fillable" state, no matter how much taker volume comes through.

**Files to read**:

- `nodes/poly/sidecars/paper-trader/server.py` — FastAPI wrapper, fill loop driver (`CHECK_ORDERS_INTERVAL_SECONDS`, `EVENT_FILL_LOOP_TICK`)
- `nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/engine.py` — the OSS engine's `check_orders()` and queue model
- `nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/orders.py` — `LimitOrder.status` transitions
- `nodes/poly/app/src/features/copy-trade/plan-mirror.ts:vwap_floor_breach` — planner side that sizes the placement; cross-reference the limit-price-vs-target-VWAP logic
- `docs/spec/poly-copy-trade-execution.md` — `NEVER_PAY_ABOVE_TARGET_VWAP` invariant explains why our limits cluster at-or-below BBO

## Investigation plan

1. **Reproduce locally** (don't trust prod observations alone):
   - Start the sidecar locally: `cd nodes/poly/sidecars/paper-trader && docker build . -t local-paper && docker run -p 9100:9100 local-paper`
   - Place a synthetic order at a price 1 tick below current BBO on a high-volume Polymarket market
   - Confirm engine never fills it, regardless of book depth or time
   - This isolates the bug to the engine, not the network / config / cogni-side
2. **Read `pm_trader` engine source**: find the fill predicate. Confirm it's BBO-only (vs depth-aware).
3. **Decide between three repair paths**:
   - **(a) Fix the OSS engine** — patch `pm_trader.engine.check_orders()` to consume book depth. Upstream-friendly if `pm_trader` accepts contributions; cogni-internal fork otherwise.
   - **(b) Replace `pm_trader`** — write a thin Python (or Rust/Go) engine that re-uses the Polymarket book + trades stream + our limits and produces fills with realistic queue-position assumptions. Higher upfront cost; long-term right answer if we want >2 tenants.
   - **(c) Accept the bug, document the ceiling** — the v0 trust contract becomes "paper twin fills at K% of live; K is a calibration constant" — every paper PnL number gets multiplied by 1/K. Hacky, but unblocks the matrix evaluator and downstream A/B.

   **Recommendation**: (a) first if `pm_trader` is small and patchable in a day. (b) is the right long-term answer pre-phase-4 streaming (task.0322). (c) is the unblock for _today_ if (a) + (b) are >1 week of work.

4. **Validate the fix**: run `tenant-matrix-evaluator` after, expect:
   - Q1 `decision fidelity` jumps from 97% → 99%+ (if planner code-path divergence is also ≤1%)
   - Twin `$ filled` ratio to live should be 95-105% over a 24h window — the trust contract
   - Top-mismatch reasons should no longer include `placed(mode_paper) vs skipped(...)` (that mismatch class disappears once paper actually fills)

## Acceptance criteria

- [ ] Paper twin's `$ filled` is within ±5% of prod live's `$ filled` over a fresh 24h window
- [ ] Loki shows `order_filled` events at a rate ≥80% of `place_order.complete` events
- [ ] `tenant-matrix-evaluator` Q1 hero shows ≥99% decision fidelity
- [ ] Reproduction repro is recorded as a regression test (unit or stack-test) so this doesn't silently re-break

## Adjacent issues to bundle (the dev should NOT bundle, just be aware)

- **bug.???** (file separately): Argo overlay for `poly-paper-sidecar` has an HTTP `/healthz` liveness probe that returns 200 even when the engine is filling 0 orders. Strict probe should return 503 if `fill_loop_tick.filled_count == 0` for N consecutive ticks AND `pending_count > 0`.
- **bug.???** (file separately): no per-tenant alerting on fill-rate divergence. Twin has been broken for 21+ hours; nobody noticed until the matrix evaluator surfaced it. A Grafana alert on `rate(paper_sidecar.order_filled) / rate(paper_sidecar.place_order.complete) < 0.5 for 30m` would catch this in real time.
- **chr.poly-algo-tenant-matrix**: charter doesn't currently call out paper-engine fidelity as a stability gate. After this bug is fixed, add a gate to the charter: "any matrix-derived A/B result is invalid if paper fidelity < 95% in the same window".

## Pointers (for the implementer)

- Bug: `bug.5060` (this)
- Surfacing tool: `nodes/poly/scripts/tenant-matrix-evaluator.ts` (PR #100)
- First evidence: `nodes/poly/research/tenant-matrix/2026-05-18T16-25-42/` (initial 18.5% fidelity reading) — note this was BEFORE the per-fill decision-fidelity query landed, so the number reflects $ filled ratio not decision match
- Project: `proj.poly-paper-trading`
- Vendor: `nodes/poly/sidecars/paper-trader/vendor/pm_trader/` — the OSS engine
- Spec: `docs/spec/poly-copy-trade-execution.md` (paper dispatch contract); `.context/handoff-paper-trading-review.md` (fidelity-gap catalog from previous review — read this; some of what you're about to discover was already documented)
