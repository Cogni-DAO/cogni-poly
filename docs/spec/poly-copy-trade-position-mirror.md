---
id: poly-copy-trade-position-mirror
type: spec
title: "Poly Copy-Trade Position-Mirror"
status: draft
spec_state: draft
trust: draft
summary: "Proposed replacement for the fill-driven mirror (`planMirrorFromFill`) with a position-state-driven mirror (`planMirrorFromPositionGap` + `GapExecutor`). Dissolves four classes of position-delta (D2 fill-chase, D3 hedge blindness, D4 vwap-bouncing, D6 per-fill sizing) cataloged in `work/charters/POLY_COPY_DELTA.md`. Companion to `poly-copy-trade-execution.md` — that spec remains the contract for the current pipeline; this spec is its successor."
read_when: Designing or implementing the position-mirror refactor. Reviewing any change to `plan-mirror.ts`, `mirror-pipeline.ts`, or the placement-side state machines. Triaging delta classes D2–D6 from `chr.poly-copy-delta`.
implements: proj.poly-copy-trading
owner: derekg1729
created: 2026-05-13
verified: null
tags: [poly, polymarket, copy-trading, position-state, mirror, executor, draft]
---

# Poly Copy-Trade Position-Mirror

> **Status: draft.** Not yet implemented. This spec scopes the work — the architectural replacement for the current fill-driven mirror. Prerequisite: PR #23 / task.5043 (sub-second chain-driven target-fill detection). Without that, position-state can't be kept current in real time.

## Goal

Replace the **fill-replay** mirror with a **position-state** mirror. The mirror's job stops being "react to each target fill" and becomes "keep our position proportional to target's current position, executed with VWAP discipline."

In one diagram:

```
                ┌─────────────────────────────────────┐
                │  TARGET POSITION STATE              │
                │   (target_wallet, token_id)         │
                │   shares · cost_usdc · vwap · side  │ ◄── updated by chain-log source (task.5043)
                │   last_block · last_event           │
                └────────────────┬────────────────────┘
                                 │
                                 ▼  per-tick OR on target-state-change
                ┌─────────────────────────────────────┐
                │  DESIRED POSITION                   │
                │   (our_wallet, target, token_id)    │
                │   = scale(target_shares,            │
                │           capital_alloc,            │
                │           per-target cap)           │
                │   vwap_ceiling = target_vwap + ε    │
                └────────────────┬────────────────────┘
                                 │
                                 ▼
                ┌─────────────────────────────────────┐
                │  POSITION GAP                       │
                │   gap_shares = desired − actual     │
                │   action: BUY  if gap > +ε          │
                │           SELL if gap < −ε          │
                │           idle if |gap| < ε         │
                └────────────────┬────────────────────┘
                                 │
                                 ▼
                ┌─────────────────────────────────────┐
                │  GAP EXECUTOR                       │
                │   • limit price ≤ vwap_ceiling      │
                │   • passive quote, NOT chase        │
                │   • per-tick reconcile resting → gap│
                │   • cancel + replace only when      │
                │     gap changes materially          │
                └─────────────────────────────────────┘
```

## Why this exists — the delta classes it dissolves

| Class                      | How current mirror fails                                                                 | How position-mirror dissolves it                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **D2 fill-chase**          | Reacts to target's _last fill_; that price clusters at spikes.                           | Limit price bounded by target's _cumulative VWAP_, not their last match. Spikes don't move the gap.                  |
| **D3 hedge blindness**     | `target_dominant_other_side` gate skips entries below 20% USDC fraction.                 | Each token-id has its own gap row. Both legs of a hedge are tracked independently. The dominance concept is deleted. |
| **D4 vwap-floor bouncing** | `vwap_floor_breach` fires per fill — skip on rise, re-evaluate on next fill, skip again. | VWAP ceiling is a limit-price bound on the executor's working orders. Continuous, no bouncing.                       |
| **D6 per-fill sizing**     | Sizer scales `fill.size_usdc` by capital fraction; never settles.                        | Sizer derives `desired_shares` from `target_shares × capital_alloc`. Steady-state IS the design.                     |

See `work/charters/POLY_COPY_DELTA.md` for the full delta-cause taxonomy.

## Non-Goals

- Anything about target screening / ranking — see `chr.poly-wallet-research`.
- Multi-leg arbitrage strategies that _aren't_ mirrors of a target. This is still copy-trade.
- Replacing the placement / signing / authorize stack — `PolyTradeExecutor.placeIntent` continues to be the bottom of the call graph.

## Design

Sections below define the proposed pipeline: data-model additions, three new feature-layer modules (target-state-updater, gap planner, gap executor), idempotency redesign keyed on `(target_id, token_id, gap_version)`, and a four-phase migration that leaves the current fill-driven pipeline in force until phase 4.

## Data model

Three tables (or in-memory caches with DB persistence — TBD). Names use the `poly_copy_*` family for grep-ability.

### `poly_copy_target_position_state` — authoritative target state

Updated by the chain-log source on every `OrderFilled` for a tracked target. One row per `(target_wallet, token_id)`.

| Column                 | Type                               | Purpose                                                    |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `target_wallet`        | `address`                          | indexed                                                    |
| `token_id`             | `text`                             | CTF tokenId                                                |
| `condition_id`         | `text`                             | denormalized for join-free reads                           |
| `outcome`              | `text` (YES/NO/multi-outcome name) | for logs + dashboard                                       |
| `cumulative_shares`    | `numeric(20,6)`                    | sum of buys − sum of sells                                 |
| `cumulative_cost_usdc` | `numeric(20,6)`                    | weighted by side; BUY adds, SELL subtracts at avg          |
| `cumulative_vwap`      | `numeric(8,5)`                     | derived: cost/shares                                       |
| `last_block_number`    | `bigint`                           | chain head this state reflects                             |
| `last_event_index`     | `int`                              | log index in that block — tiebreaker for same-block events |
| `updated_at`           | `timestamptz`                      | wall-clock for staleness alerting                          |

INVARIANT: monotonic-by-`(last_block_number, last_event_index)`. A reorg-retracted event rewrites the state row by replay; we don't carry stale state forward.

### `poly_copy_desired_position` — derived view (or table, depending on perf)

One row per `(our_billing_account_id, target_wallet, token_id)`. Recomputed every tick or on target-state-change.

| Column               | Type            | Purpose                                                                |
| -------------------- | --------------- | ---------------------------------------------------------------------- |
| `billing_account_id` | `uuid`          | tenant scope                                                           |
| `target_wallet`      | `address`       | which target this scaling came from                                    |
| `token_id`           | `text`          |                                                                        |
| `desired_shares`     | `numeric(20,6)` | `target.cumulative_shares × capital_alloc_fraction × per_target_scale` |
| `vwap_ceiling`       | `numeric(8,5)`  | `target.cumulative_vwap × (1 + ε_vwap_tolerance)`                      |
| `desired_at_block`   | `bigint`        | which target state version this was computed from                      |

### `poly_copy_position_gap` — virtual view, NOT a table

A `WITH` join over `poly_copy_desired_position` and `poly_trader_position_snapshots` (or live `poly_copy_trade_fills` aggregation). The gap is recomputed every executor tick — never persisted, never goes stale by definition.

```sql
gap_shares  = desired_shares − COALESCE(actual_shares, 0)
gap_action  = CASE
                WHEN gap_shares > min_lot THEN 'BUY'
                WHEN gap_shares < -min_lot THEN 'SELL'
                ELSE 'idle'
              END
```

## Pipeline layers (new)

Three sibling slices under `nodes/poly/app/src/features/`. The `wallet-watch/` slice stays the same (chain source from task.5043). The other two slices get rewritten.

```
features/wallet-watch/        ← UNCHANGED — emits Fill events
features/copy-trade/
  target-state-updater.ts     ← NEW — Fill → poly_copy_target_position_state UPSERT
  plan-mirror.ts              ← REWRITTEN — planMirrorFromPositionGap(gap, market, ourState)
  position-mirror-pipeline.ts ← NEW — per-tick reconcile loop
features/trading/             ← MOSTLY UNCHANGED — placeIntent / cancelOrder / order-ledger
  gap-executor.ts             ← NEW — VWAP-bounded passive placement
```

### `target-state-updater`

Pure: `Fill[] → StateDelta[]`. Applied via UPSERT against `poly_copy_target_position_state`. No decisions. No CLOB calls.

### `planMirrorFromPositionGap(gap, target, market_constraints)` — pure planner

Replaces `planMirrorFromFill`. Inputs:

- `gap`: `{ token_id, gap_shares, vwap_ceiling }`
- `target`: `{ cumulative_vwap, cumulative_shares, last_block }`
- `market_constraints`: `{ tick_size, min_shares, min_usdc_notional, end_date }`

Output: `{ kind: "place" | "skip" | "cancel_replace" | "idle", … }`.

The planner is now **idempotent given the same state**. A target's spike fill doesn't change `gap` (because cumulative VWAP barely moves on a 1% top-up). The planner returns `idle` on the next tick → no order churn.

### `GapExecutor`

```ts
class GapExecutor {
  constructor(deps: { placeIntent; cancelOrder; findOpenForMarket; ledger });

  // Called per tick (cheap, often) or on target-state-change push.
  async reconcile(gap: PositionGap, book?: OrderBook): Promise<ReconcileResult>;
}
```

Logic:

1. Read open mirror orders for `(our_wallet, token_id)`.
2. If `|gap_shares| < min_lot` → ensure no working orders; idle.
3. If a working order exists AND its `(side, price)` is within tolerance of the desired `(gap_action, vwap_ceiling)` → keep resting; idle.
4. Else cancel + replace OR place new — but ONLY if `desired.vwap_ceiling` is reachable on the book. Don't pay through the offer.

INVARIANTS:

- `NEVER_PAY_ABOVE_TARGET_VWAP_PLUS_EPSILON` — `limit_price <= vwap_ceiling` always. Failure here means we just paid spike price; this is the load-bearing invariant.
- `ONE_WORKING_ORDER_PER_GAP` — at most one resting order per `(billing_account, target, token_id, side)`. Cancel-then-place semantics.
- `EXECUTOR_IDEMPOTENT_PER_TICK` — `reconcile(gap)` called N times with the same `gap` produces at most 1 net order action (the first call; subsequent calls observe the resting order and idle).

## Idempotency & dedup model

The fill-driven model used `client_order_id = clientOrderIdFor(target_id, fill.fill_id)`. That breaks here — there's no causal fill any more.

New scheme: `client_order_id = clientOrderIdFor(target_id, token_id, gap_version)` where `gap_version` is a `bigint` incremented every time the gap materially changes (definition TBD — likely a hash of `(desired_shares, vwap_ceiling)`).

DB partial unique index: `(billing_account_id, target_id, token_id, gap_version)`. Same dedup property, different key.

## Migration path from the current pipeline

This is intentionally NOT a forklift. The migration is staged. **Composability seam first** — every later phase ships behind the per-target sizing-policy-kind switch from Phase 1, so legacy targets stay on the legacy planner by construction.

1. **Phase 0 — prerequisite (shipped via task.5043, PR #23):** chain-log source feeds the existing `planMirrorFromFill` with sub-second fills. No data-model change.

2. **Phase 1 — per-target sizing-policy switch (the kill-switch seam):** add `sizing_policy_kind text NOT NULL DEFAULT 'auto'` to `poly_copy_trade_targets` with `CHECK ('auto' | 'min_bet' | 'target_percentile_scaled')`. Promote it to user/AI configurable through the existing `POST/PATCH /api/v1/poly/copy-trade/targets` surface. Thread it through `buildSizingPolicy` so explicit kinds override snapshot inference (`'auto'` preserves today's behavior verbatim). Zero production change at deploy. **Future policy variants ship behind this switch:** add a `SizingPolicySchema` variant + a CHECK enum value + a `case` in `applySizingPolicy`, then a user PATCHes one target to A/B against the legacy planner.

3. **Phase 2 — `position_gap` SizingPolicy variant:** add `kind: "position_gap"` to `SizingPolicySchema` (poly/app types) and the DB CHECK enum, plus a `case` in `applySizingPolicy`. Gap math uses inputs the planner already receives (`state.target_position.tokens[].size_shares`, `state.position.our_qty_shares`, `state.cumulative_intent_usdc_for_token`). NO new tables. NO new modules. NO new pipeline. Per-target opt-in via PATCH from Phase 1; legacy targets untouched. Done condition: candidate-a A/B shows gap-shaped sizing materially reduces minority-side delta vs `target_percentile_scaled` for the same target on the same markets. **Ship Phase 3+ only if this evidence wins.** **🟡 IN-FLIGHT** (PR #92).

4. **Phase 3 — chain-driven target state:** authoritative chain-event-driven target-position-state. Resolve in Phase 3 design: extend existing `polyTraderPositionSnapshots` (already has `traderWalletId, conditionId, tokenId, shares, costBasisUsdc, avgPrice`) with `lastBlockNumber, lastEventIndex` provenance + a chain-event UPSERT path, OR build the parallel `poly_copy_target_position_state` table per the data-model section above. Either way, target-state-updater writes only fire for targets flipped to `position_gap`. Still fill-triggered re-evaluation.

5. **Phase 4 — `GapExecutor` + tick-driven reconciliation:** continuous gap re-derivation between fills, cancel-replace under book change, `client_order_id = clientOrderIdFor(target, token, gap_version)`. Replaces resting-sweep TTL job.

6. **Phase 5 — full cutover + legacy delete:** flip remaining targets. Delete `planMirrorFromFill`, `target_dominant_other_side`, `vwap_floor_breach`, `followup_position_too_small`, and the resting-sweep TTL job. Net delete ~1500 LOC.

Each phase is a separate PR. Phase 1's switch means each later phase ships ahead of cutover for any specific target.

## Open questions

- ~~Where does `capital_alloc_fraction` live per target?~~ **Answered 2026-05-18 (locked).** Per-target capital allocation lives on `poly_copy_trade_targets.mirror_capital_alloc_usdc` (nullable; CHECK-required when `sizing_policy_kind = 'position_gap'`). Semantics are **per-target-total** (proportional book copy), NOT per-condition: `scale = alloc / Σ target_total_open_book_cost_usdc` applied uniformly across every token target holds. Requires a per-target whole-book hydration capability (`getTargetTotalBookCost`, 30s TTL cache, reuses `listAllUserPositions`). Cross-target safety stays at `poly_wallet_grants`. See locked-design status note below.
- `vwap_ceiling` slippage budget `ε`: 0 means we never pay above target's VWAP at all — strict, but never executes when target is in a winning trend. 0.005 (50 bps) is the current `vwap_tolerance` default — keep it as the v1 starting point.
- SELL path: target reduces a position → our `desired_shares` drops → gap turns negative → executor places SELL. The current `NO_SELL_IN_MIRROR` invariant (we close via redeem only) needs revisiting. Likely deleted under position-mirror, replaced by a managed SELL with the same VWAP discipline.
- Multi-target capital share: if target A has 100 sh Hon and target B has 200 sh Hon, what's our desired? `sum(scale(each))` or `max(scale(each))` or some mean? Affects how independent the per-target loops are.
- Reorg interaction with position-state. Chain reorg retracts a target's recent fill → target_state row goes BACKWARD by `block_number`. Our previously-emitted desired_shares is now over-estimated. Executor must cancel the over-allocated working order. Spec needs a `STATE_CAN_REGRESS_ON_REORG` invariant + executor handling.

## Intelligent-monitoring gaps (Phase 2 → Phase 5 punch list)

Phase 2 (`position_gap` variant, PR #92) wired the sizing math but assumes Phase-1-era inputs. The gaps below are what's still missing before the mirror can claim to _intelligently monitor_ a target's positions vs. merely _correctly size each fill_. Grouped by lens, with the phase that resolves each.

Severity: **F**(ail — blocking for steady-state mirroring) · **C**(oncern — degrades intelligence but mirror still works) · **B**(lock — Phase 2 correctness hole).

### 1. Position truth

| Gap                                                                                                                                                                      | Sev | Resolved by                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ------------------------------------------- |
| Target position read from Data-API `/positions` — stale + cumulative-only. No `(last_block_number, last_event_index)` versioning.                                        | F   | Phase 3 (`poly_copy_target_position_state`) |
| Our position read from local `MirrorPositionView` aggregated from `poly_copy_trade_fills`. Intent-based, not chain-truth. Drifts on partial fills, cancels, redemptions. | F   | Phase 3 (chain-truth read path on our side) |
| No staleness signal — planner doesn't know if `state.target_position` is 5s or 5min old. Fails open (no skip on stale data).                                             | C   | Phase 3 (versioning surfaces age)           |
| Chain reorg → target's `cumulative_shares` retreats. No reorg handling today; the `STATE_CAN_REGRESS_ON_REORG` invariant is unscheduled.                                 | F   | task.5043 follow-up (D7)                    |
| No SELL-side gap. `gap < 0` skips `followup_not_needed` — we can never reduce. Means the mirror can grow into a target's position but never out of one.                  | F   | Phase 4 (`GapExecutor` SELL)                |

### 2. Hedge awareness

| Gap                                                                                                                                                                                                                                                                                                                                                             | Sev          | Resolved by                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| **Opposite-leg blind spot.** `applyPositionGapSizing` reads `our_qty_shares` only when `state.position.our_token_id === fill_token_id`. If the fill arrives on `opposite_token_id` and we hold both legs, `our_shares` falls to 0 and the gap over-states by `opposite_qty_shares`. Latent today (dominance gate kills most paths) but a real correctness hole. | B            | One-line fix in Phase 2 (sum both legs when token matches). Tracked under invariant `GAP_CONSULTS_BOTH_LEGS`. |
| Multi-outcome markets (>2 token_ids per condition_id) — `aggregatePositionRows` in `types.ts` only surfaces the top-2 net legs. Tokens 3+ silently invisible to `state.position`.                                                                                                                                                                               | C            | Phase 3 chain-truth read (state per-token, not per-condition)                                                 |
| No portfolio-delta view. Two targets, each long different sides of a binary → we mirror both, hold both legs, no module sees the cross-target portfolio risk.                                                                                                                                                                                                   | F (at scale) | Phase 3+ (cross-target reconciler — not yet scoped)                                                           |
| `position_followup` (hedge ratios, max hedge fraction) is bypassed under `position_gap`. The safety nets only existed under the legacy policy. New gap-level guards need to come back.                                                                                                                                                                          | C            | Phase 4 (gap-level safety guards on `GapExecutor`)                                                            |

### 3. VWAP semantics

| Gap                                                                                                                                                                                                                                                                                                  | Sev              | Resolved by                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `target_vwap_for_token` = `Σcost_usdc / Σsize_shares` of `state.target_position.tokens[]` is **cost basis on currently-held shares**, NOT running entry VWAP across full fill history. After target SELLs, the residual `avgPrice` is the entry cost on what remains — distorted vs. cash-flow VWAP. | C                | Phase 3 (`cumulative_vwap` from chain log — see data model §)                    |
| `vwap_tolerance` is a single scalar (0.005). No volatility, depth, or recency adaptation.                                                                                                                                                                                                            | C                | Phase 4 (tolerance becomes order-property, can adapt)                            |
| Our own VWAP (`our_vwap_usdc`) tracked in `MirrorPositionView` but **unused under `position_gap`**. Can't answer "is our average entry better or worse than target's?" at decision time.                                                                                                             | C                | Phase 4 (used as input to cancel-replace decisions)                              |
| `vwap_floor_breach` is a per-fill skip — does not move with the market. If we miss the entry window and price rises permanently above target's VWAP, we're locked out of further gap-closing forever, even as our position drifts far from desired.                                                  | F (steady-state) | Phase 4 (`limit_price = target_vwap + ε` becomes order property; gate dissolved) |

### 4. Neg-risk handling

| Gap                                                                                                                                                                                   | Sev                            | Resolved by                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Planner is neg-risk-blind. `MarketConstraints.negRisk` is read by the CLOB adapter for routing but never surfaces to the planner. Each outcome gets an independent gap.               | C                              | Not currently scheduled; surfaces `negRisk` on `MarketConstraints` to planner when neg-risk basket math is needed. |
| Multi-outcome neg-risk basket: target rotates between outcomes A/B/C over time → we see N independent token positions, N independent gaps. No "this is one cohesive 1-of-N bet" view. | F (for neg-risk-heavy targets) | New scope — not in the current Phase 3/4 spec. Tracking as `proj.poly-copy-trading` follow-up.                     |
| Neg-risk fee math is higher. We don't size for it, so cumulative-intent caps and per-leg caps under-cost.                                                                             | C                              | New scope — adapter-side fee model needs to land on `MarketConstraints` before planner can read it.                |

### 5. Multi-target reality

| Gap                                                                                                                                                                                                                                                                                                                                                                                                        | Sev                     | Resolved by                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`target_scale` is a global bootstrap constant~~ **Resolved 2026-05-18 (locked).** PR #102 added `target_scale numeric(8,7)`; design review concluded the entire abstraction was wrong (opaque fraction, per-condition framing breaks proportional book copy, per-trade cap is anti-tracking). Superseded by `mirror_capital_alloc_usdc` (per-target whole-book) per the locked-design status note below. | 🟢 SHIPPED (redesigned) | follow-up PR — `target_scale` dropped, `mirror_capital_alloc_usdc` added, whole-book Σ derivation in `applyPositionGapSizing`, `mirror_max_usdc_per_trade` ignored under `position_gap` |
| Two targets mirrored by one tenant into the same market → each target computes its gap independently against the same `our_qty_shares`. First-evaluated target sets our exposure; later targets see "we already hold it" and shrink. **Evaluation order determines allocation.**                                                                                                                           | F (at scale)            | Phase 3+ (cross-target reconciler — see open question §"Multi-target capital share")                                                                                                    |
| No portfolio-level capital allocation. `mirror_max_usdc_per_trade` is per-target. No "total mirror book ≤ $X" cap.                                                                                                                                                                                                                                                                                         | C                       | Phase 3+ design — open question above                                                                                                                                                   |
| `poly_copy_trade_attribution` exists in the schema but isn't read by the planner. We can't size-by-target-performance.                                                                                                                                                                                                                                                                                     | C                       | Phase 3+ (size from attribution → `target_scale`)                                                                                                                                       |

## Invariants

Binding when this spec ships. None are enforced today (status: draft).

- `TARGET_STATE_FROM_CHAIN_ONLY` — `poly_copy_target_position_state` is written only by the chain-log source's state-updater. Data-API writes here are forbidden.
- `NEVER_PAY_ABOVE_TARGET_VWAP_PLUS_EPSILON` — see executor invariant above.
- `ONE_WORKING_ORDER_PER_GAP` — see executor invariant above.
- `STATE_VERSION_MONOTONIC_PER_BLOCK` — same `last_block_number` + same `last_event_index` ⇒ same `cumulative_shares` / `cumulative_cost_usdc`. Replay determinism.
- `GAP_DRIVES_EVERYTHING` — `client_order_id`, sizing, limit price, and cancel-decision are all derived from a `(gap, target_state)` tuple. No fill-history references in the placement path.
- `GAP_CONSULTS_BOTH_LEGS` — `applyPositionGapSizing` reads `our_qty_shares` for the fill token from _either_ `our_token_id` _or_ `opposite_token_id` if either matches. The current Phase 2 implementation only checks `our_token_id` (see §"Intelligent-monitoring gaps" #2.1); the one-line fix lives in Phase 2 cleanup, not Phase 3. Without it, two-leg holdings over-state the gap by `opposite_qty_shares`.

## Pointers

- `chr.poly-copy-delta` (charter) — the delta-cause taxonomy this spec dissolves
- `poly-copy-trade-execution.md` — the contract for the current fill-driven pipeline (still in force until phase 4)
- PR #23 / task.5043 — the chain-log source this spec depends on
- `/delta-minimizer` skill — per-incident investigator; feeds new tapes back to the charter

## Status notes

- **2026-05-13:** Spec drafted as the planned successor to the fill-driven mirror. Triggered by the swisstony WTA Parma incident, which exposed that information-lag (D1, PR #23) is necessary but not sufficient — the bigger structural bug is fill-chase (D2). Phase 0 lands with PR #23. Phase 1+ is a separate project, not yet scheduled.
- **2026-05-17 (later same day):** Phase 2 (`position_gap` SizingPolicy variant) ships in PR #92 (task.5001). Single PR — schema CHECK enum + contract enum + discriminated-union variant + `applyPositionGapSizing` planner branch + bootstrap `DEFAULT_POSITION_GAP_TARGET_SCALE=1e-4` + Sinner/Ruud unit replay. Per-target opt-in via PATCH from Phase 1; legacy targets untouched. Done condition (candidate-a A/B vs `target_percentile_scaled`) is the next gate.
- **2026-05-17 (post-merge review, task.5002):** added §"Intelligent-monitoring gaps" — five-lens catalogue (position truth, hedge awareness, VWAP semantics, neg-risk, multi-target) of what still has to harden between Phase 2 wire integration and Phase 5 full cutover. Surfaces the Phase 2 opposite-leg blind spot (`GAP_CONSULTS_BOTH_LEGS`) as a one-line fix in the existing planner, and flags neg-risk basket awareness + multi-target portfolio cap as scope additions not yet in the Phase 3/4 design.
- **2026-05-17:** Revised migration after the swisstony ATP Sinner/Ruud incident ([report](../../nodes/poly/research/delta-minimizing/atp-sinner-ruud-2026-05-17-2026-05-17T17-30-01/report.html)). Composability-first: Phase 1 is now the per-target sizing-policy-kind switch (no table, no module, no behavior change at deploy), Phase 2 is the `position_gap` `SizingPolicy` variant (uses inputs the planner already has — no new infrastructure), and the original "table + updater + executor + idempotency redesign" is deferred to Phase 3+ pending A/B evidence from Phase 2. Rationale: leverages the `SIZING_POLICY_IS_DISCRIMINATED` invariant in `features/copy-trade/types.ts` so legacy targets stay on the legacy planner by construction. Phase 1 ships as the work item this revision was filed under.

- **2026-05-18 (Phase 2 conviction-knob redesign — LOCKED):** PR #102 shipped `target_scale numeric(8,7) NOT NULL DEFAULT 0.0005`. Three iterations of design review (this branch) found that knob shape AND a follow-up `mirror_alloc_per_condition_usdc` shape both miss the north star. **Locked design follows.**

  **North star (one sentence):** _hold a miniature of target's BOOK; as target grows / shrinks / rotates, our positions track theirs in proportion, scaled to our budget._ Sizing must be derived from target's **whole open book**, not per-condition (else a target with N conditions gets N× our money — per-market flat-betting, not proportional copy).

  **One knob:** `mirror_capital_alloc_usdc numeric(10,2) NULL` — total dollars I'm betting tracks this target's whole book. CHECK-required when `sizing_policy_kind = 'position_gap'`; nullable otherwise. **No default.**

  **Math (per fill, inline in `applyPositionGapSizing`):**

  ```
  scale          = capital_alloc_usdc / Σ target_total_open_book_cost_usdc
  desired_shares = target_shares × scale            (per token target holds)
  gap_shares     = desired_shares − our_shares
  intent_usdc    = gap_shares × fill.price          → market-floor LOWER bound only (no upper cap) → PLACE or SKIP
  ```

  Planner passes `+Infinity` as the ceiling to `applyMarketFloors` so per-fill intent can exceed `alloc` when target averages up past their cost-basis VWAP. `alloc` is the per-target whole-book budget, NOT a per-trade ceiling.

  **Derived conviction threshold (no explicit knob):** `target_position_threshold = market_min × target_book / alloc`. Floats with target's book size and our alloc. Replaces both the legacy pXX statistical filter (different conviction model — kept side-by-side under `target_percentile_scaled` until A/B picks a winner) and any hand-set `min_target_position_usdc`.

  **What's dropped / not added:**
  - `target_scale` column — wrong abstraction, dropped.
  - `mirror_max_usdc_per_trade` — `position_gap` does NOT read it. Per-trade caps under book matching are anti-tracking (they throttle the proportional copy mechanism). Column stays on the row for legacy policies (`target_percentile_scaled`, `min_bet`); deferred-drop is Phase 5 cutover. Wire-level safety moves entirely to `poly_wallet_grants`.
  - `mirror_filter_percentile` — legacy only; `position_gap` ignores.
  - No `min_target_position_usdc` / `max_target_position_usdc` knobs — derived threshold + market_min handle the lower bound; proportional book copy IS the upper bound.
  - No percentage-of-balance representation in v0 — filed as v1 follow-up (`mirror_capital_alloc_pct` of wallet equity; needs wallet-equity read path; fractional-Kelly framing).

  **Cap responsibility table (under `position_gap`):**
  | Concern | Owner |
  | --- | --- |
  | Per-target total exposure | `mirror_capital_alloc_usdc` (implicit ceiling) |
  | Cross-target tenant total | `poly_wallet_grants.total_at_risk_usdc` |
  | Cross-target daily velocity | `poly_wallet_grants.daily_cap_usdc` |
  | Per-fill economic floor | `market.min_usdc_notional` |
  | Σ ≤ 0 / math-glitch | planner skip `target_position_below_threshold` |
  | Account balance < alloc | executor wire `INSUFFICIENT_BALANCE` (planner stays naive) |

  **Operational details for the implementation PR:**
  1. **Target whole-book hydration (NEW dep).** Bootstrap must wire a cached `getTargetTotalBookCost(targetWallet) → Σ cost_usdc across all open conditions`. v0: reuse `dataApiClient.listAllUserPositions(targetWallet, { sizeThreshold: 0 })` with a 30s TTL cache shared across tick callers (target's book doesn't move > minor % in 30s). Hydration error → fail-closed skip via Σ=0 guard.
  2. **Migration ordering.** Single transaction: `DROP target_scale` → `ADD mirror_capital_alloc_usdc NULL` → `UPDATE poly_copy_trade_targets SET mirror_capital_alloc_usdc = 5.00 WHERE sizing_policy_kind = 'position_gap'` → add CHECK constraint. Three in-flight `position_gap` tenants (cand-a/RN1-GAP, cand-a/GAP, preview/swiss-gap) get `$5.00` as the migration-time value; operator PATCHes per-tenant afterward.
  3. **Σ = 0 guard.** `applyPositionGapSizing` short-circuits when `target_total_open_book_cost_usdc ≤ 0` (target closed all positions, live read failed, etc.). Reuse `target_position_below_threshold` skip reason.
  4. **Drop `PositionGapSizingPolicySchema.max_usdc_per_condition`.** Drop the cumulative-intent cap check from `applyPositionGapSizing`. Drop `FALLBACK_POSITION_GAP_TARGET_SCALE` bootstrap constant. Drop the two-step "compute scale then apply" indirection — single inline derivation.
  5. **Cross-condition / cross-target reconciler (still missing).** Two targets, same market, both long different sides → each computes its scale independently against the same `our_shares`. Evaluation order determines allocation. Deferred to Phase 3+ design.
  6. **VWAP gate stays per-fill for v0.** `vwap_floor_breach` still fires per-fill against target's residual cost-basis. Phase 4 `GapExecutor` promotes to `limit_price = min(fill.price, target_vwap + ε)` order property and dissolves the per-fill gate.
