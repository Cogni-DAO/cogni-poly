---
id: poly-range-relative-mirror-2026-05-26
type: research
title: "Design: Range-Relative Position Allocation + Cold-Start Forward-Only Entry (position_gap rewrite)"
status: draft
trust: draft
summary: "Rewrites `position_gap`'s sizing math in place. Anchors our allocation to where a target sits in their *assumed per-condition position range* (hardcoded `target_range_max_usdc` knob; min=0 because target traders never sell, only redeem) rather than to their *current point* on a moving Σ-book. Adds a cold-start forward-only invariant so a freshly-activated tenant never catches up to an existing target position. NO SELL — `gap ≤ 0 → followup_not_needed` is preserved verbatim. Single `applyPositionGapSizing` rewrite; no new policy variant."
read_when: "Reviewing why preview position_gap tenants (eae447b1 / 0e16cf1a / b0ca1bce) lose monotonically with cap_alloc despite the 2026-05-18 locked design; editing `applyPositionGapSizing` in `plan-mirror.ts`; deactivating current preview position_gap tenants in favor of new forward-only ones in `chr.poly-algo-tenant-matrix`."
owner: derekg1729
created: 2026-05-26
tags: [poly, copy-trading, sizing-policy, design, draft]
---

# Range-Relative Position Allocation + Cold-Start Forward-Only Entry

> **Status: draft for review.** Not implemented. Companion proposal to `docs/spec/poly-copy-trade-position-mirror.md` — slots in as **Phase 2.5**, an in-place rewrite of the `position_gap` `SizingPolicy` variant shipped in PR #92 (locked design 2026-05-18). No new policy kind; `applyPositionGapSizing` is rewritten. Two new invariants: `COLD_START_FORWARD_ONLY`, `RANGE_DRIVES_DESIRED`.

## Motivation

### The signal

The `chr.poly-algo-tenant-matrix` 2026-05-26 report shows the `position_gap` variant losing monotonically with `cap_alloc`:

| tenant   | policy                             | cap_alloc | resolved | realized |       pnl% |
| -------- | ---------------------------------- | --------: | -------: | -------: | ---------: |
| eae447b1 | target_percentile_scaled (control) |       $15 |      144 |     $567 | **−2.87%** |
| 0e16cf1a | position_gap                       |    $1,000 |      242 |   $2,256 | **−6.42%** |
| b0ca1bce | position_gap                       |  $500,000 |      800 | $728,119 | **−7.34%** |

The loss-rate gradient is 1× → 2.2× → 2.5× the auto/TPS control. This is not sample-size; it is a property of the policy at scale.

### Two structural causes (hypothesis)

The locked `position_gap` design (`docs/spec/poly-copy-trade-position-mirror.md` 2026-05-18 status note) computes:

```
scale          = capital_alloc_usdc / Σ target_total_open_book_cost_usdc      ← point-in-time Σ
desired_shares = target_shares × scale                                        ← point-in-time target_shares
gap_shares     = desired_shares − our_shares
```

Both `Σ target_total_open_book_cost_usdc` and `target_shares` are **instantaneous** values. The math chases whatever target is holding _right now_, with the only ceiling being the per-fill VWAP gate (`fill.price ≤ target_vwap × 1.005`).

This produces two systemic biases:

**Cause A — Peak-chasing.** When target is at the top of their range on a condition (e.g. swisstony from $500 → $10k per the empirical p95 distribution; rare conditions reach $400k+), `target_shares` is at max → `desired_shares` is at max → we keep adding. When they then dip, our `gap_shares` flips negative but the cap has already been burned at the peak entries. The VWAP gate dampens this when target is genuinely DCA-ing up, but does nothing about _position-size_ peak-chasing — only price peak-chasing.

**Cause B — Cold-start catch-up.** When a new tenant is provisioned (or `sizing_policy_kind` is flipped from `target_percentile_scaled` to `position_gap`), the first observed fill on an _existing_ target position computes a large `gap_shares` against `our_shares = 0`. We then race to close that gap at whatever price the market is currently offering. For a target that built quietly weeks ago at favorable prices, "catching up" means paying the current (worse) price for shares we _should have_ bought along with them. The current design has no notion of "we missed this entry; skip."

These two compose: at high `cap_alloc`, a cold-started tenant chases peaks across hundreds of markets simultaneously — exactly the shape of the b0ca1bce loss profile.

### Why this isn't fully D2

The charter's D2 row blames _fill-chase_ (executor-layer: per-fill triggers, reactive to spike fills, no debounce/limit-ceiling). The Phase 3 GapExecutor dissolves that.

But the _sizing math itself_ — even with a perfect executor — anchors to a point estimate. If swisstony oscillates a condition from $100k → $500k → $200k → $400k, the GapExecutor would faithfully track the oscillation, scaled. We'd top-tick with them. That's not D2 fill-chase; that's the policy correctly executing a fundamentally point-anchored objective.

The proposal below moves the **objective function** from "match target's current point" to "match target's relative position within their own range."

---

## Proposed design

### Core insight

Swisstony does not hold a steady $X position on a market. They scale in and out within a per-condition range. The information signal we want to copy is **where in their range they currently sit**, not their absolute share count. Map that relative position onto our own per-condition allocation cap.

### Sizing math — rewrite of `applyPositionGapSizing`

```
// Per (billing_account, target, condition), on the FIRST post-activation
// observation, snapshot baseline = target_position_usdc_on_condition.
// Persisted in poly_copy_target_condition_baseline. INSERT ON CONFLICT DO NOTHING.
//
// All subsequent ticks read the persisted baseline. Pre-existing target
// position never enters our objective function — we mirror forward growth only.

baseline       = poly_copy_target_condition_baseline.baseline_target_position_usdc
delta          = max(0, target_position_usdc_on_condition − baseline)
relative       = min(delta / target_range_max_usdc, 1.0)

desired_usdc   = mirror_max_alloc_per_condition_usdc × relative
desired_shares = desired_usdc / target_vwap_on_token
gap_shares     = desired_shares − our_shares
if gap_shares ≤ 0  → skip followup_not_needed             (NO SELL, unchanged)
```

Where:

- `target_range_max_usdc` — **hardcoded per-target knob** (new column on `poly_copy_trade_targets`). Parameterized one-shot by looking at swisstony's lifetime per-condition max-position-USDC distribution and picking p95. When target breaches it: clamp `relative = 1.0` and emit a Loki alert; operator PATCHes the knob upward.
- `mirror_max_alloc_per_condition_usdc` — our per-condition cap. Replaces `mirror_capital_alloc_usdc` from the locked 2026-05-18 design (Σ-book budget) entirely.
- `target_position_usdc_on_condition` — target's cost-basis on the condition right now. Already plumbed via `state.target_position.tokens[].cost_usdc` (summed across both legs for binary; see "Multi-outcome handling" below).
- `target_vwap_on_token` — same `state.target_position.tokens[].vwap` the existing `vwap_floor_breach` gate uses.

**Why delta-since-baseline, not absolute position.** First draft of this design fenced cold-start by `fill.observed_at < mirror_activated_at → skip`. That fence is decorative — wallet-watch starts polling forward at activation, so pre-activation fills never enter the pipeline anyway. The real cold-start failure: target holds $300k pre-activation, the _next_ post-activation fill is e.g. a $1k add, our `state.target_position` reads the full $300k cumulative, `relative` jumps to 0.6 immediately, we catch up the entire $12 desired in a single fill at that fill's price. Delta-since-baseline forces `relative` to walk from 0 by construction. We mirror the $1k add proportionally; we ignore the pre-existing $300k forever (until target either fully exits, see below, or we re-activate).

**Range minimum is structurally 0**, not observed-min, because the target traders we copy are predominantly long-only / hold-to-redemption. Cumulative position USDC walks 0 → up → up → ... → 0 (on resolution). **Verified empirically** (see `range-relative-parameterization-2026-05-26.md` Q1): swisstony has 0 SELLs over 1.69M fills in 90 days; RN1 has 0 SELLs in 7d, 1 SELL in 30d (at-payout / functional redemption), and a single strategic-exit burst on 2026-04-01 (3 SELLs at $0.30, $27k total). The strategic-exit case is acknowledged-and-accepted: when target reduces a position, our `delta` drops → `desired` drops → `gap ≤ 0` → skip (NO SELL). We hold our existing position to whatever the market resolves at. Cost is bounded by `mirror_max_alloc_per_condition_usdc` per affected condition; no SELL infrastructure required.

**Worked example — late activation** (swisstony, using deploy-locked values from parameterization SQL — `target_range_max_usdc = $10,000`, `mirror_max_alloc_per_condition_usdc = $20`):

- Activation at t0. swisstony already holds $3,000 on condition X (a top-quartile position size per Q2 distribution).
- First post-activation fill: target adds $50 → target*position_usdc = $3,050 → baseline snapshot = $3,050 (captured AT this fill, AFTER the add) → delta = 0 → relative = 0 → skip `before_baseline_snapshot`. \_No catch-up*.
- Subsequent fill: target adds another $500 → target_position_usdc = $3,550 → delta = $500 → relative = 500/10,000 = 0.05 → `desired_usdc = $1.00` → likely below market floor → may skip or place at floor.
- Target grows to $8,000 (delta = $4,950) → relative ≈ 0.50 → desired = $10 → place.
- Target grows to $13,000 (delta = $9,950) → relative ≈ 1.00, breach alert → desired = $20 (clamped) → place. `poly.mirror.range_breach` emitted; operator decides whether to raise `target_range_max_usdc`.
- Target exits to $0 (redeem) → delta = $0 → desired = $0 → gap < 0 → skip (NO SELL). We hold our $20 to redemption alongside target.

**Worked example — clean cold-start** (target_position = $0 at activation):

- Baseline snapshot captured at first post-activation fill = $0.
- delta = target_position_usdc; relative walks 0 → 1.0 monotonically as target builds.
- We mirror in proportion from the first dollar.

**Range breach**: when `delta > target_range_max_usdc`, clamp `relative = 1.0`; we sit at full `mirror_max_alloc_per_condition_usdc`; emit `poly.mirror.range_breach` so the operator decides whether to widen.

**Multi-outcome handling.** Per-condition-sum is the correct scale for both binary and true multi-outcome conditions — the sum represents target's total economic exposure to the question, which is what we anchor against. Each fill places against the specific token's vwap and our position on that specific token (`desired_shares = desired_usdc / target_vwap_on_THIS_token`; `gap_shares = desired_shares − our_shares_on_THIS_token`). Same math whether the condition has 2 tokens (binary) or N≥3 tokens (true multi-outcome). No skip, no special case.

**Neg-risk events.** Neg-risk is a per-market boolean (`attributes.negativeRisk = true` in Gamma) flagging that the market is one of several binary sub-conditions belonging to a parent event group (e.g. each candidate in an election is its own conditionId with YES/NO tokens, all flagged `negativeRisk: true`, with adapter-level netting at resolution). The planner already keys `baseline + delta + desired` per `condition_id`, so each neg-risk sub-condition is mirrored independently as a normal binary. Event-level adapter netting affects resolution payout, not sizing math. No special handling needed; **empirically ~24% of swisstony/RN1 conditions are neg-risk** (per `range-relative-parameterization-2026-05-26.md` Q4), so this is the common path, not an edge case.

**Cross-outcome spread gap (known v0 limitation).** Same gap that already exists for binary hedges: target holds both YES and NO; we mirror whichever leg they fill on; we don't spontaneously buy the other leg. Multi-outcome and neg-risk event spreading are the N-outcome generalization of that exact gap — if target holds positions on 3 of 5 outcomes and we only get triggered on outcome-1, we end up holding only outcome-1. v0 accepts this as the limit of fill-driven mirroring; Phase 3 GapExecutor would close it. No new failure mode introduced by the rewrite.

### Baseline snapshot semantics

Per `(billing_account_id, target_id, condition_id)`:

- Snapshot is captured exactly once, on the **first observed post-activation fill** for that triple.
- Stored as the target's `target_position_usdc_on_condition` value _at_ that fill (i.e. after the fill has been applied to target's state).
- `INSERT INTO poly_copy_target_condition_baseline ... ON CONFLICT DO NOTHING` so concurrent ticks are safe.
- Never updated. If target fully exits (`target_position_usdc → 0`) and later re-enters, the stale baseline still applies — re-entry will compute `delta` from $0 against the old baseline. **Open question**: do we want to invalidate baseline on full-exit (more responsive) or keep it sticky (simpler, no oscillation risk)? V0 picks **sticky** — full-exit is rare on swisstony/RN1 (they hold-to-redemption), and stickiness avoids the failure mode where target wash-cycles in-and-out and we keep re-baselining at unfavorable points.

**Known cost: the triggering fill is systematically dropped.** Because baseline is captured _after_ the triggering fill is applied to target state, that fill's `delta = 0` by construction → the planner emits `before_baseline_snapshot` and skips. Across swisstony's ~1,000 conditions this is ~1,000 missed entries lifetime per target. This is by design — alternative (snapshot _before_ the fill) re-introduces the catch-up risk B1 was meant to fix on the triggering fill itself. The aggregate loss is small and bounded; do NOT "optimize" this in a future PR without re-litigating B1.

### Cold-start

Cold-start is fully handled by the **delta-since-baseline** mechanism in the sizing math above — there is no separate cold-start fence. `mirror_activated_at` exists only to define "which fill is the first post-activation observation" for baseline-snapshot purposes; it is NOT a fill-skip predicate.

The earlier draft included a `fill.observed_at < mirror_activated_at → skip` invariant. Dropped: pre-activation fills never enter the pipeline (wallet-watch begins polling forward at activation), so the predicate is decorative. The real catch-up failure mode it was named to prevent (target holds $300k pre-activation → next post-activation fill computes `relative = 0.6` against `our_shares = 0` → race the entire desired into one fill) is dissolved by delta-since-baseline, not by a timestamp fence.

### Range expansion + alerts

When target breaches `target_range_max_usdc` (their assumed ceiling):

- **Behavior**: clamp `relative = 1.0` → no new entries above the ceiling. Emit `poly.mirror.range_breach` Loki event with `{ target_wallet, condition_id, current_position_usdc, target_range_max_usdc, breach_pct }`.
- **Operator action**: PATCH `target_range_max_usdc` upward (next tick recomputes), or accept the cap.
- **Rejected**: dynamic auto-widen on breach. Auto-widening would pile us in at exactly the moment a target is breaking new ground — which is usually either a high-conviction signal we want OR a top we want to avoid, and the algorithm can't tell which. Force operator-in-the-loop for v0.

### Why hardcoded, not computed

Two reasons:

1. **Simplicity.** No dynamic range hydration adapter, no rolling-window state, no reset-on-exit detection logic. One number per target. Operator-tunable.
2. **Stability.** A computed `range_max` updates whenever the target sets a new high — which is the worst time to revise our scaling assumption (see "Range expansion" above). A hardcoded ceiling is sticky on purpose.

The price: the knob needs to be sensibly set. **Parameterization step (one-shot, before deploy)**: query `poly_trader_fills` for swisstony's per-condition cumulative-position-USDC over the past month, take the p90 or p95 of per-condition maxima, round to a clean number. Same for RN1. That number becomes `target_range_max_usdc` for that target. Re-evaluate quarterly.

This step belongs in the parameterization PR description; doesn't need its own design doc.

---

## What this replaces vs preserves

| Existing element                                                                 | Status                                                                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind: "position_gap"` SizingPolicy                                              | **Preserved** (single variant — math is rewritten in place)                                                                                          |
| `mirror_capital_alloc_usdc` (per-target whole-book)                              | **Replaced** — column dropped from `poly_copy_trade_targets`; superseded by `target_range_max_usdc` + `mirror_max_alloc_per_condition_usdc`          |
| `Σ target_total_open_book_cost_usdc` hydration (`getTargetTotalBookCost`)        | **Deleted** — no longer needed; per-condition position is read straight off `state.target_position.tokens[]`                                         |
| `vwap_floor_breach` gate (`fill.price ≤ target_vwap × (1 + tol)`)                | **Preserved** — still the per-fill price ceiling                                                                                                     |
| `NO_SELL_IN_MIRROR` / `gap ≤ 0 → followup_not_needed`                            | **Preserved verbatim** — target traders never sell, we never sell, redeem-only                                                                       |
| `client_order_id = clientOrderIdFor(target_id, fill_id)`                         | **Preserved** — still fill-driven, no `gap_version` redesign                                                                                         |
| Phase 1 `sizing_policy_kind` switch + `SIZING_POLICY_IS_DISCRIMINATED` invariant | **Preserved** — still gates legacy `target_percentile_scaled` / `min_bet` targets                                                                    |
| INSERT*BEFORE_PLACE, RLS on `poly_copy_trade*\*`, idempotency                    | **Preserved**                                                                                                                                        |
| Phase 3 `GapExecutor` (chain-driven, tick-driven)                                | **Orthogonal** — this rewrite changes the _objective_ the planner computes; Phase 3 changes the _executor_ that reconciles against it. They compose. |

### What's new

- **`target_range_max_usdc numeric(12,2) NOT NULL`** on `poly_copy_trade_targets` — assumed per-condition position ceiling, hardcoded per target via parameterization SQL.
- **`mirror_max_alloc_per_condition_usdc numeric(10,2) NOT NULL`** on `poly_copy_trade_targets` — our per-condition cap.
- **`mirror_activated_at timestamptz NOT NULL DEFAULT now()`** on `poly_copy_trade_targets` — marks when this `(billing_account, target)` started mirroring (used only to define "first post-activation fill" for baseline-snapshot semantics; not a fill-skip predicate).
- **`poly_copy_target_condition_baseline`** (NEW small table). PK `(billing_account_id, target_id, condition_id)`. Columns: `baseline_target_position_usdc numeric(12,2) NOT NULL`, `captured_at timestamptz NOT NULL DEFAULT now()`, `captured_at_fill_id text NOT NULL` (provenance for debugging). Insert-once via `ON CONFLICT DO NOTHING`. **RLS**: enable RLS on the table; policy explicitly grants `SELECT`/`INSERT` to `app_user` filtered by `billing_account_id = current_setting('app.billing_account_id')::uuid`, mirroring `poly_copy_trade_targets`. Migration MUST include the `CREATE POLICY` statement; do not rely on inheritance.
- **`FORWARD_ONLY_VIA_BASELINE` invariant** (planner): `delta = max(0, target_position_usdc − baseline_target_position_usdc)`. No path to `desired_usdc > 0` exists without a persisted baseline row.
- **`RANGE_DRIVES_DESIRED` invariant**: `desired_usdc = mirror_max_alloc_per_condition_usdc × min(delta / target_range_max_usdc, 1.0)`. No other path to `desired_usdc`.
- **`NO_SELL_IN_MIRROR` invariant (re-affirmed)**: `gap_shares ≤ 0 → skip followup_not_needed`. Target traders never sell — only redeem at resolution. Verified by SELL-audit gate in parameterization SQL (any SELL on swisstony/RN1 blocks deploy pending revision).
- **`poly.mirror.range_breach` Loki event** when `delta ≥ target_range_max_usdc`, for operator visibility.
- **New `before_baseline_snapshot` skip reason** in the planner contract enum (for the first post-activation fill that establishes baseline but cannot place since delta is 0 by definition).

### What's deleted

- `mirror_capital_alloc_usdc` column on `poly_copy_trade_targets` (replaced).
- `getTargetTotalBookCost` adapter + its 30s TTL cache (no longer called).
- The Σ-book scale computation in `applyPositionGapSizing` lines 213–264.

### Aggregate exposure ceiling (C1)

The old design had an implicit per-target ceiling of `mirror_capital_alloc_usdc` (whole-book). The new design has only a per-condition ceiling, so total exposure is:

```
max_aggregate_exposure_per_target = mirror_max_alloc_per_condition_usdc × N_active_conditions
```

For swisstony (1,085 token positions in the 2026-05-03 snapshot, ≈ similar condition count), `max_alloc = $20` implies a theoretical ceiling of ~$21,700 per target. The old `mirror_capital_alloc_usdc = $1,000` ceiling is no longer in force.

This is by design — proportional copy across many conditions is the goal — but the implication MUST be reflected in the deploy:

- `poly_wallet_grants.total_at_risk_usdc` for every new matrix tenant must be sized for `mirror_max_alloc_per_condition_usdc × expected_active_conditions × safety_factor` (safety factor = 2 covers ramp + breach allowance). Parameterization SQL produces `expected_active_conditions` per target (lifetime distinct condition_id count from `poly_trader_fills` ÷ 4, as a rough simultaneity factor — refine if available).
- `poly_wallet_grants.daily_cap_usdc` covers velocity; sized for expected daily new-condition entries × max_alloc.
- A tenant tripping its grant cap mid-soak is a soak-invalidating event. Pre-size grants generously.

The wire-level cap (`CAPS_LIVE_IN_GRANT` per the locked 2026-05-18 note) remains the only enforcement; the planner does not implement an aggregate ceiling.

---

## Migration plan

Single PR. No staged variant rollout — all `position_gap` tenants inherit the new math at deploy. Nothing on prod uses `position_gap` today; the only live consumers are preview/candidate-a matrix tenants which are paper-trading.

1. **Parameterization SQL — COMPLETE.** See [`range-relative-parameterization-2026-05-26.md`](./range-relative-parameterization-2026-05-26.md) for full Q1–Q4 results. Locked deploy values:
   - **`target_range_max_usdc`** = **$10,000** for both swisstony and RN1 (Q2 p95). The doc's earlier $500k example was off by ~50×; corrected.
   - **`mirror_max_alloc_per_condition_usdc`** tiers = $5 / $20 / $200 (C4 design choice).
   - **`poly_wallet_grants.total_at_risk_usdc`** per tier (sized against swisstony peak_concurrent=852): $8,520 / $34,080 / $340,800.
   - **`NO_SELL_IN_MIRROR`** upheld with one documented RN1 deviation (2026-04-01 strategic-exit burst). Design accepts the cost — when target sells, our gap goes negative, we skip, we hold to resolution.
   - **Per-condition-sum** handles both binary AND true multi-outcome correctly. Q4: 0% true multi-outcome (>2 tokens/condition) on both targets, but **~24% of conditions are neg-risk sub-conditions** (parent-event groupings of binaries) — these mirror normally as binaries, no special handling.
2. **Schema migration.** Add `target_range_max_usdc`, `mirror_max_alloc_per_condition_usdc`, `mirror_activated_at` (default `now()`). Create `poly_copy_target_condition_baseline` (PK = `(billing_account_id, target_id, condition_id)`). Drop `mirror_capital_alloc_usdc`. Single transaction. Backfill `mirror_activated_at = now()` for existing rows.
3. **Planner rewrite.** Rewrite `applyPositionGapSizing` (lines 199–264 of `plan-mirror.ts`) per the math above. Delete the Σ-book / `getTargetTotalBookCost` hydration path. Add `before_baseline_snapshot` skip reason. Add baseline-row INSERT-on-conflict to the planner-adjacent path (or push to a thin adapter — TBD in implementation PR).
4. **Bootstrap wiring.** Update `buildSizingPolicy` to read the new fields. Drop `mirror_capital_alloc_usdc` plumbing.
5. **Tenant matrix reset.** Deactivate the three current preview/candidate-a `position_gap` tenants (eae447b1, 0e16cf1a, b0ca1bce). Register fresh forward-only tenants in `chr.poly-algo-tenant-matrix` with the new schema. Concrete `mirror_max_alloc_per_condition_usdc` tiers (C4): **$5 / $20 / $200**. All start from `mirror_activated_at = deploy_time` — clean cold-start for the evaluation window. Grants sized per C1 formula.
6. **Soak + evaluate.** Win condition (C4 — revised). 24h is too short to accumulate comparable resolved counts (the original gradient ran over 144/242/800 resolved markets). **Primary signal (early)**: `distance_to_swisstony` on OPEN positions at matched condition counts — measurable within hours of soak start. **Secondary signal (later)**: re-run `tenant-matrix-evaluator` after ≥7d to compare realized PnL gradient against the prior matrix. The 2.87 → 6.42 → 7.34% gradient flattening (or inverting) is the ultimate confirmation; the open-position distance is the early signal we soak against.

---

## Open questions

- **Knob value.** What's the right `target_range_max_usdc` for swisstony / RN1? Resolved by parameterization SQL Q2 (lifetime per-condition max, p95).
- **Baseline invalidation on full-exit.** Sticky for v0 (rationale in "Baseline snapshot semantics" above). Revisit if matrix shows we systematically miss re-entries on cycle-trading conditions.
- **Multi-outcome handling.** Resolved: per-condition-sum is the correct scale for both binary AND true multi-outcome. No skip. Neg-risk events are handled trivially (each sub-condition is its own binary). See "Multi-outcome handling" and "Neg-risk events" paragraphs in the sizing-math section. Parameterization Q4 reports the prevalence as informational context, not a gate.
- **Resolution edge.** Target's position freezes at market close → delta stays constant → desired stays constant → we hold to redemption alongside target. No special case needed.
- **Chain-log source (PR #23 / task.5043).** Orthogonal — ship under existing Data-API hydration; sub-second target_position updates land for free when PR #23 merges.

## Promotion to spec (C6)

Two invariants introduced here (`FORWARD_ONLY_VIA_BASELINE`, `RANGE_DRIVES_DESIRED`) belong in `docs/spec/poly-copy-trade-position-mirror.md` once this design is accepted. The implementation PR MUST also edit the spec — adding a Phase 2.5 section between the existing Phase 2 (locked 2026-05-18) and Phase 3 (chain-driven target state) status notes, capturing:

- New invariants in the §Invariants block (alongside `NEVER_PAY_ABOVE_TARGET_VWAP_PLUS_EPSILON`, `GAP_DRIVES_EVERYTHING`, etc.).
- New columns / new baseline table in the §Data model section.
- Status note dated to merge, summarizing the in-place rewrite + what was deleted from the 2026-05-18 design.
- `NO_SELL_IN_MIRROR` re-affirmed (was an "open question" in the 2026-05-18 design; locked closed here pending SELL-audit deploy-gate).

---

## Why this isn't Phase 3 GapExecutor

Phase 3 changes **how** orders are placed (tick-driven, cancel-replace, resting-orders-derived-from-gap) and **where target state lives** (chain-event-driven authoritative table). Both are large architectural moves; D2 dissolution is their explicit goal.

This proposal changes **what objective we're optimizing for** (range-relative ↔ point-anchored) without touching the placement pipeline. It can ship in the existing fill-driven Phase 2 pipeline and survive a future swap to Phase 3 — the planner output shape is unchanged.

If both ship, they compose: Phase 3 GapExecutor reconciles continuously against a `desired_shares` that is now range-relative-derived. The dominance-by-peak failure mode dissolves, the per-fill chase failure mode dissolves, _and_ the executor handles SELL gracefully.

If only one ships first, this proposal is the smaller/lower-risk one and clears a class of error that Phase 3 alone does not.

---

## Pointers

- `chr.poly-copy-delta` — D2/D6 are the classes this addresses (objective layer, not executor layer)
- `docs/spec/poly-copy-trade-position-mirror.md` — the Phase 2/3/4/5 migration this slots into as **Phase 2.5**
- `docs/research/poly/backfill-spike-2026-05-05.md` — corpus that makes range hydration viable for RN1/swisstony from day 1
- `work/charters/POLY_ALGO_TENANT_MATRIX.md` — A/B substrate for evaluation
- `nodes/poly/app/src/features/copy-trade/plan-mirror.ts:199–264` — `applyPositionGapSizing` is the structural template for `applyRangeRelativeSizing`
- `.claude/skills/delta-minimizer/SKILL.md` — per-market validation discipline for the retroactive probe
- `.claude/skills/data-research/SKILL.md` — SQL-aggregation pattern for range hydration (do NOT load fills into JS)

## Status notes

- **2026-05-26 (draft).** Derek raised two issues from `chr.poly-algo-tenant-matrix` 2026-05-26 report: (1) fill-chasing still happens under `position_gap`; (2) target's per-condition allocation is a _range_, not a point — our objective should mirror the relative position in that range. Pairs with cold-start discipline so a newly-activated tenant doesn't catch up to existing target positions at unfavorable prices. **Next step:** parameterize `target_range_max_usdc` from `poly_trader_fills` (one-shot SQL on swisstony's past 30d), then ship the planner rewrite + schema migration + tenant-matrix reset as a single PR.
- **2026-05-26 (revision 1).** First draft proposed a new `range_relative` SizingPolicy variant + dynamic per-condition range hydration + SELL handling. Derek rejected: no new variant (rewrite `position_gap` in place), hardcode the range knob (one-shot lookup, not dynamic), absolutely no SELL (target traders never sell — only redeem). Also rejected the retroactive empirical-validation probe; commit to the design intuition and validate via the matrix once live. All preview position_gap tenants will be deactivated and replaced with fresh forward-only tenants at deploy.
- **2026-05-26 (revision 4 — multi-outcome skip dropped, neg-risk semantics clarified).** External review caught a fundamental error in revision 3: Q4 measured `COUNT(DISTINCT token_id) per condition_id`, which detects true multi-outcome (>2 tokens) but **cannot detect neg-risk** — neg-risk is a per-market flag (`attributes.negativeRisk = true`) on parent-event groupings of binary sub-conditions. Re-queried against `poly_market_metadata.raw->>'negativeRisk'`: **23.9% of swisstony's conditions are neg-risk; 25.5% of RN1's**. Had the design shipped any form of "skip when neg-risk" rule, ~24% of alpha-bearing activity would have been silently dropped. Corrections:
  - **Dropped the multi-outcome skip entirely.** No skip path, no `poly.mirror.neg_risk_skipped` event, no skip reason. The math (per-condition-sum scale, per-token vwap conversion, per-token gap) is correct for binary AND true multi-outcome AND neg-risk events. No special handling needed.
  - **Added Neg-risk events clarification** to the sizing-math section: parent-event groupings are handled trivially because the planner already keys baseline/delta/desired per `condition_id`. Each neg-risk sub-condition mirrors as its own binary.
  - **Documented the cross-outcome spread gap** as a known v0 limitation that already exists for binary hedges and naturally extends to multi-outcome — not a new failure mode.
  - **Q4 in parameterization doc** updated: stays as informational ("0% true multi-outcome") and now includes corrected neg-risk prevalence number.
- **2026-05-26 (revision 3 — parameterization complete, approved).** Q1–Q4 SQL run against candidate-a's `poly_trader_fills` + `poly_trader_position_snapshots`. Results in [`range-relative-parameterization-2026-05-26.md`](./range-relative-parameterization-2026-05-26.md). Headline corrections folded into this doc:
  - **Scale was wrong.** Earlier `target_range_max_usdc = $500k` example reflected a hypothetical, not data. Q2 p95 = **$10,000** for both swisstony and RN1. Worked example updated.
  - **NO_SELL_IN_MIRROR upheld with documented deviation.** swisstony 0 SELLs in 90d. RN1 had a single 36-second strategic-exit burst on 2026-04-01 ($27k at $0.30). Design's gap-goes-negative-→-skip behavior handles this gracefully; cost is bounded and accepted.
  - **Grant sizing locked** for new matrix tenants per tier: $8,520 / $34,080 / $340,800 against swisstony.
  - ~~Per-condition-sum binary-only is fully safe~~ (revised in revision 4 — see above).
  - Design **APPROVED** by external review. Ready for implementation PR.
- **2026-05-26 (revision 2).** External design review flagged a blocking issue (B1) and five concerns. Applied:
  - **B1 (blocking) — cold-start fence was decorative.** First post-activation fill against existing target position still computed full `relative` immediately. Replaced with **delta-since-baseline**: snapshot `baseline_target_position_usdc` per `(billing_account, target, condition)` on first post-activation observation; drive `relative = min(max(0, current − baseline) / target_range_max_usdc, 1.0)`. New `poly_copy_target_condition_baseline` table. `relative` now walks from 0 by construction.
  - **C1 — aggregate exposure unbounded.** Made explicit. Added `poly_wallet_grants` sizing formula (`per_condition_cap × N_active × 2`) and made it a parameterization-SQL output (Q3).
  - **C2 — "never sell" was asserted, not verified.** Added SELL-audit query as a deploy-gate (Q1). Non-zero count blocks migration.
  - **C3 — per-condition vs per-token granularity.** Locked: per-condition-sum for binary only; `poly.mirror.neg_risk_skipped` warn for multi-outcome until proper handling lands.
  - **C4 — win condition under-specified.** Concrete max_alloc tiers ($5 / $20 / $200) declared. Early signal switched to `distance_to_swisstony` on open positions (24h-soak compatible); realized-PnL gradient becomes the ≥7d confirmation signal.
  - **C5 — parameterization window risk.** Switched from 30d to lifetime; locked p95; reasoning documented inline.
  - **C6 — promotion-to-spec undefined.** Added Promotion-to-spec section + implementation-PR requirement to edit `docs/spec/poly-copy-trade-position-mirror.md` Phase 2.5.
