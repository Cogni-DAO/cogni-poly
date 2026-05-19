---
id: poly-paper-trading-shortcomings
type: spec
title: "Poly Paper-Trading: Known Shortcomings vs. Real CLOB"
status: active
spec_state: active
trust: reviewed
summary: "Canonical, evidence-cited list of every way the paper-trading sidecar (pm_trader engine) diverges from how Polymarket's real CLOB executes orders. Every paper-trading number the tenant-matrix-evaluator surfaces (realized $, PnL, VWAP, fill rate) inherits at least one of these biases. This is the trust contract for paper-trading outputs."
read_when: Reading any paper-trading scorecard (matrix-evaluator, paper-trade-diff-analysis), promoting an algo from paper to live, deciding whether to scale live-money allocation, or designing a fix to a paper-side bug.
implements: proj.poly-paper-trading
owner: derekg1729
created: 2026-05-19
verified: 2026-05-19
tags: [poly, polymarket, paper-trading, sidecar, fidelity, trust-contract]
---

# Poly Paper-Trading: Known Shortcomings vs. Real CLOB

> **The trust contract**: paper-trading numbers are useful for **relative ranking of policies** running through the same simulator. They are **NOT useful as absolute predictors of live $ PnL**. Every consumer of paper numbers MUST factor in the shortcomings below.

## Goal

Be the single source of truth for every known way the paper sidecar's fill semantics diverge from real Polymarket CLOB execution. Every consumer of paper-trading numbers (matrix-evaluator, paper-trade-diff-analysis, dashboards, algo-promotion decisions) reads this to understand which numbers carry which biases — and what each bias does to the conclusion.

## Non-Goals

- Not a design doc for the fixes. Each bug item (bug.5015 / bug.5016 / bug.5018) carries its own design.
- Not a port/adapter architecture spec — see [`poly-copy-trade-execution.md`](./poly-copy-trade-execution.md) for `MarketProviderPort` and adapter shape.
- Not a paper-trading deployment / config guide — see [`work/projects/proj.poly-paper-trading.md`](../../work/projects/proj.poly-paper-trading.md).

## Invariants

These propositions are load-bearing for any conclusion drawn from paper data:

- **PAPER_INHERITS_AT_LEAST_ONE_BIAS** — every paper-side number in the matrix-evaluator output (`realized_size_usdc`, `pnl_usdc`, fill rate, decision counts, VWAP) inherits at least one of S1–S9 below. A conclusion that ignores all of them is unsupported.
- **RELATIVE_BEATS_ABSOLUTE** — two paper tenants on the same simulator path admit relative comparison (biases approximately cancel for ranking). Absolute comparison paper-vs-LIVE composes biases and does not.
- **PNL_REQUIRES_FILL_PRICE** — until [bug.5018](https://poly.cognidao.org/api/v1/work/items/bug.5018) lands, paper PnL is uncomputable from the cogni ledger. Any "paper $X profit" claim is unsupported.
- **POSITION_STATE_IS_NOT_PORTED** — paper and live track positions in different stores (sidecar SQLite vs. chain-derived `poly_trader_position_snapshots`). Planner branches gated on position state DIVERGE between paper and live ([bug.5015](https://poly.cognidao.org/api/v1/work/items/bug.5015)).
- **SHORTCOMINGS_ARE_GATEKEEPERS** — promoting an algo from paper to live-$ allocation requires satisfying the trust gate in §"Trust gate" below. No paper signal alone justifies scaling live-$.

## Motivation (read first)

We operate a live-money tenant on Polymarket. The constraint is: we want high confidence before scaling live $ allocation higher, especially for high-frequency / high-$ policies like `position_gap`. Paper trading is our derisking surface — but only if we know exactly which of its numbers we can trust and which we can't.

This doc enumerates every known way the paper sidecar (`nodes/poly/sidecars/paper-trader/`, vendored `pm_trader` engine + maker-fill pre-pass patch from bug.5005) diverges from how the real Polymarket CLOB matches orders. Each shortcoming is cited to code or to a real measurement.

## Design

This doc is a **catalog**, not a redesign. Format per shortcoming:

- **Sx — One-line shorthand** (status tag: FIXED / OPEN / accepted-v0)
- **Was / Now / Evidence** — code-cited
- **Real CLOB behavior** — what should happen
- **Impact** — measured if measurable, qualitative if not
- **Filed** — bug item or "n/a" if accepted

The catalog ends with a "what numbers can I trust" table and the trust gate for promoting paper signal to live-$ scaling.

Fixes against each shortcoming live in their referenced bug items. This doc is the index, not the implementer.

## Polymarket CLOB ground truth (one paragraph)

Polymarket runs a standard central limit order book. Matching rules: makers rest at their limit; arriving takers match at the BEST opposing maker's limit price (= the maker's price, NOT the taker's). Price-time priority breaks ties at the same price level. A marketable arriving order (BUY ≥ best ask, SELL ≤ best bid) matches immediately at the resting maker's price. Trade prints carry one price per fill = the maker's limit. There is NO price improvement past the maker's quote.

## Shortcoming inventory

Each row carries: what's wrong, code evidence, real-CLOB behavior, measured impact (where we have it), bug item (where filed), and "consumer of paper numbers, beware."

### S1 — Snapshot-pass fill price (FIXED 2026-05-19 via bug.5016 / PR #121)

**Was**: `engine.py:527-544` snapshot pass walked the live order book bottom-up via `simulate_buy_fill`, filling our resting limit at the cheapest crossing ask — phantom price improvement no real CLOB grants the maker.

**Now**: same gate (best_ask ≤ limit), but fill clears at `order.limit_price` for `min(intent, sum_of_crossing_ask_size)`. See [bug.5016](https://poly.cognidao.org/api/v1/work/items/bug.5016) + PR #121.

**Residual concern (S5 below)**: crossing_size remains a loose upper bound — see S5.

### S2 — Maker pre-pass fill price (FIXED 2026-05-19 via bug.5016 / PR #121)

**Was**: `engine.py:738-805` `_apply_maker_fills` synthesized a 1-level book at `trade.price` (the price someone ELSE's lower-priority maker received), filling US at that sub-limit price.

**Now**: synthesized at `order.limit_price`. Real-CLOB-accurate for the case where our limit had queue priority over the maker who actually traded.

**Residual concern**: the maker pre-pass does not model price-time priority WITHIN a price level. If multiple makers sit at our limit, real CLOB fills them in time order; paper attributes the entire crossing trade volume to us. ~Inflates our fill rate at busy price levels. **Magnitude unmeasured.**

### S3 — `filled_size_usdc = intent_size_usdc` on partial fills (CRITICAL, OPEN — bug.5018)

**Evidence**: `nodes/poly/sidecars/paper-trader/server.py:29-32` (v0 invariant docstring):

> v0 fill-amount approximation: full fill is assumed when upstream reports `status="filled"`. `filled_size_usdc = intent.size_usdc`. Partial fills aren't surfaced separately.

The engine's `mark_filled` is called on both full AND partial fills (`engine.py:545-555`: `if not fill.filled and not fill.is_partial: continue` — both branches proceed to mark_filled). So a partial fill of $100 on a $290 intent is reported to the cogni TS adapter as `filled_size_usdc=290`.

**Real CLOB behavior**: trade prints carry exact share counts; partials are visible.

**Impact**:

- `poly_copy_trade_fills.attributes.filled_size_usdc` on paper rows is INTENT, not REALIZED.
- The matrix-evaluator's `realized_size_usdc` aggregates intent USDC for filled-status rows, not actual share×price notional.
- **Any consumer using `realized_size_usdc` to compare $ volumes between paper and LIVE is reading INTENT on the paper side.**

**Filed**: see S6 — same fix.

### S4 — No `fill_price`, `total_shares`, `fees_usdc` on the wire (CRITICAL, OPEN — bug.5018)

**Evidence**: `OrderReceipt` schema at `server.py:244-253`:

```python
class OrderReceipt(BaseModel):
    order_id: str
    client_order_id: str
    status: str
    filled_size_usdc: float    # = intent (see S3)
    submitted_at: str
    attributes: Optional[dict[str, Any]] = None
```

No `fill_price`. No `total_shares`. No `fees_usdc`. The engine's internal `db.insert_trade()` records all of these (`avg_price`, `shares`, `amount_usd`, `fee`, `slippage_bps`, `levels_filled`, `is_partial`) but **only the order-state is returned over the HTTP wire**.

`GET /history` exposes the engine trade rows, but is in-pod-only (localhost:9100). The TS adapter doesn't call it.

**Downstream impact**:

- **PnL is uncomputable from the cogni ledger for any paper tenant.** Matrix-evaluator's `pnl_usdc` field is `0` for every paper row across every bundle since the tool shipped (2026-05-18, [task.5048](#)).
- **VWAP per paper position is uncomputable.**
- **Fill-quality metrics** (slippage, price improvement vs. target VWAP, fee-adjusted realized) are uncomputable on paper.
- **bug.5016 (S1/S2 above) is INVISIBLE at the cogni layer.** The engine's corrected behavior is provable only via unit tests, not via the running ledger. Verifying the fix on preview requires hitting in-pod `/history` (no current path) OR trusting unit-test parity.

**Filed**: [bug.5018](https://poly.cognidao.org/api/v1/work/items/bug.5018). Acceptance: extend `OrderReceipt` + TS adapter + ledger `attributes` to carry `fill_price`, `total_shares`, `fees_usdc`.

### S5 — Snapshot-pass `crossing_size` is a loose upper bound (OPEN)

**Evidence**: `engine.py:524-571` post-bug.5016 logic computes `crossing_size = sum(l.size for l in book.asks if l.price <= order.limit_price)` (for BUY).

**Problem**: the presence of resting asks at sub-limit prices is evidence the market has NOT recently crossed them (otherwise they'd be depleted). Treating `crossing_size` as "taker volume that would have hit us" is the wrong direction in the steady-state case.

**Real CLOB behavior**: our resting maker only fills against takers that ARRIVE during the resting period — measured by trade prints, not by current book depth.

**Honest characterization**: the maker pre-pass via data-api `/trades` is the trustworthy fill path. The snapshot pass is a fallback that may over-fill on volatile books where our limit dwells far inside the spread.

**Filed**: separate bug pending. Likely scoped: "snapshot pass should bound fill size by actual taker volume in the polling window (e.g., via `get_trades_since`), not by current book depth." Today's matrix-evaluator outputs should already discount snapshot-pass-attributed fills.

### S6 — `place_limit_order` doesn't book-walk on placement (OPEN)

**Evidence**: `engine.py:424-460` `place_limit_order` just inserts a row into the orders SQLite. Compare to `engine.buy()` at `engine.py:134` which calls `simulate_buy_fill` immediately against the live book.

**Real CLOB behavior**: a marketable BUY limit (BUY ≥ best_ask) matches IMMEDIATELY at placement against the resting ASKS, at the asks' prices. The order doesn't rest.

**Paper behavior**: every limit (marketable or not) rests until the next `check_orders` tick (≤30s later). By tick time, the book may have moved; snapshot pass under bug.5016 fills at OUR limit (not the asks' prices that would have matched at placement).

**Net effect**:

- For non-marketable limits that later cross via a real taker: bug.5016 is correct (we'd have been the resting maker; fill at our limit).
- For marketable-at-placement limits: paper UNDER-prices the fill (we'd have paid the ask, paper says we paid our limit). Mild adverse-to-paper bias.

**Magnitude unmeasured.** Suspected small in practice because copy-trade mirror typically places non-marketable limits (NEVER_PAY_ABOVE_TARGET_VWAP).

### S7 — No queue-priority modeling within a price level (OPEN, accepted v0)

**Evidence**: implicit in the maker pre-pass logic — every crossing trade is attributed in full to our order (capped at intent).

**Real CLOB behavior**: at the same price, makers fill in time-of-placement order. A late-arriving paper limit would queue behind existing makers.

**Acceptance**: documented and accepted for v0. The right v1 fix is depth-aware queue modeling using observed book + trade-print interleavings.

### S8 — Planner-state divergence between paper twin and LIVE (OPEN — bug.5015)

**Evidence**: 2026-05-19T04-46Z 5h matrix-evaluator window:

- TRUST_TWIN (preview, tps, identical config to LIVE): 71 placed, 41 filled
- LIVE (prod, tps): 25 placed, 16 filled
- 2.84× placement gap; 84.1% EXACT decision match (not the 98.4% headline — see [bug.5015](https://poly.cognidao.org/api/v1/work/items/bug.5015))

**Root**: the planner's branches (`layer_scale_in`, `followup_position_too_small`, `target_position_below_threshold`, `position_cap_reached`, `already_resting`) are gated on the mirror's CURRENT POSITION STATE. LIVE has months of accumulated real positions; TRUST_TWIN paper account is newer with thinner state. Same target fill triggers different branches.

**Impact**: TRUST_TWIN as a faithful prediction of LIVE behavior is broken even on identical config. Comparing paper tenants RELATIVE to each other (both running the same biased simulator) is more trustworthy than absolute comparison to LIVE.

**Filed**: [bug.5015](https://poly.cognidao.org/api/v1/work/items/bug.5015). Candidate fixes: bootstrap paper from LIVE position snapshot at tenant creation; periodic reset; or document and accept the fidelity ceiling.

### S9 — Cross-tick fill aggregation (OPEN, low priority)

**Evidence**: the maker pre-pass iterates ALL trade prints in the polling window. If 5 SELL-takers print at sub-limit prices in 30s, paper sums all crossing volume and attributes to us, capped at intent.

**Real CLOB behavior**: after takers #1 deplete our resting maker, subsequent takers hit OTHER makers, not us.

**Net effect on $ filled**: small in practice — our orders are intent-bounded (typically $5–$50 per placement for tps, larger for position_gap), so the cap fires before queue exhaustion would in real life.

## What numbers can I trust?

| Metric                                               | Paper trustworthiness                  | Notes                                                                                                           |
| ---------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `decisions` (planner outputs)                        | High (~99%)                            | Planner is pure; not affected by sidecar shortcomings.                                                          |
| `placement_rate` (placed / decisions)                | Medium                                 | Inflated by S8 (planner-state divergence); same on twin vs. LIVE only when twin's position state has converged. |
| `filled_count`                                       | Medium                                 | S1+S2 are fixed (post-bug.5016); S3 means partial-vs-full is unclear; S5/S7 inflate count at busy price levels. |
| `realized_size_usdc` (sum of fills' intent USDC)     | Medium-Low                             | S3 INTENT not REALIZED. Bias is upward when partials are common.                                                |
| `pnl_usdc`                                           | **Not computable on paper today** (S4) | Bundle returns `0` for every paper row. Filed bug.5018.                                                         |
| VWAP per position (paper)                            | **Not computable today** (S4)          | Same.                                                                                                           |
| Relative ranking of two paper tenants on same config | High                                   | Both run through same biased simulator; biases approximately cancel for ranking.                                |
| Absolute paper $ vs. LIVE $                          | **Don't trust without caveat**         | Compose of S3 + S4 + S5 + S7 + S8 biases.                                                                       |

## Trust gate for promoting an algo from paper to live

A paper signal is sufficient to scale live-$ allocation only when:

1. The signal is a RELATIVE ranking across paper tenants (not an absolute $ projection).
2. The competing tenants run the same simulator path (e.g., both `position_gap`, or both `tps`).
3. S4 (no fill_price) is resolved enough to compute paper PnL via fill-price × outcome lookup. Until bug.5018 lands, PnL claims are unsupported.
4. S8 (planner-state divergence) is acknowledged in the conclusion. A paper-twin outperforming LIVE on the same config is suspect — most likely the divergence, not signal.

**Specifically**: any claim that "policy X realized $Y in paper" should explicitly note "Y is intent USDC on filled rows, not realized notional, until bug.5018 lands."

## References

- Project: [`work/projects/proj.poly-paper-trading.md`](../../work/projects/proj.poly-paper-trading.md)
- Charter (matrix tenant accounts): [`work/charters/POLY_ALGO_TENANT_MATRIX.md`](../../work/charters/POLY_ALGO_TENANT_MATRIX.md)
- Failure taxonomy: [`work/charters/POLY_COPY_DELTA.md`](../../work/charters/POLY_COPY_DELTA.md)
- Engine source: `nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/engine.py`
- Wire schemas + v0 invariant docstring: `nodes/poly/sidecars/paper-trader/server.py`
- Maker-fill pre-pass: bug.5005 (Phase 2, PR #79); price-correction: bug.5016 (PR #121)
- Tooling: [`tenant-matrix-evaluator` skill](../../.claude/skills/tenant-matrix-evaluator/SKILL.md) + [`paper-trade-diff-analysis` skill](../../.claude/skills/paper-trade-diff-analysis/SKILL.md)
- Spec: [`poly-copy-trade-execution.md`](./poly-copy-trade-execution.md) — copy-trade lifecycle; section 13 references this doc for paper-specific fidelity caveats
