---
id: poly.research.2026-05-16-swisstony-rn1-alpha
type: research
title: "swisstony + rn1 alpha attribution & copy-trade pareto (SUPERSEDED)"
summary: "First-pass copy-trade analysis on 16d of prod data. SUPERSEDED — the basket-arb classification here was falsified mid-investigation. Preserved for traceability."
read_when: "Auditing how this investigation evolved; understanding the basket-arb misread the next agent should not repeat."
status: draft
trust: draft
created: 2026-05-16
updated: 2026-05-16
owner: derekg1729
domain: poly_target_alpha
entry_type: finding
confidence_pct: 75
authored_by: agent
data_source: cogni-production-poly-postgres
window: 16 days of fills (2026-04-30 → 2026-05-16); 13 days of position snapshots (since 2026-05-03)
supersedes: prior draft of this file dated 2026-05-16 that classified the strategy as "complete-basket arbitrage" (falsified by share-imbalance test)
superseded_by:
  - docs/research/poly/target-profile.rn1.md
  - docs/research/poly/target-profile.swisstony.md
  - docs/research/poly/2026-05-16-rn1-swisstony-aug2025-data-summary.md
note: "Live status is 'superseded' — preserved for historical traceability"
---

> **⚠️ SUPERSEDED 2026-05-16 later same day.** Read the per-target profiles above first. This file is preserved because it contains the original basket-arbitrage misclassification (falsified mid-investigation by the share-imbalance test) and the user's correct pushback — that traceability is worth keeping. The current operational knowledge lives in the `superseded_by` files in frontmatter.

# swisstony + rn1 — alpha attribution & copy-trade pareto

## TL;DR (the finding)

Both targets run **directional bets with risk-management hedges** on binary Polymarket conditions. They open a large primary position on the side they believe in, then take a small (median 18-23%, often <10%) hedge on the opposite token. They exit via redemption at resolution — **zero sells across 246k+ fills.** This is not basket arbitrage (an earlier finding from this same investigation; falsified by the share-imbalance test below).

The strategy's P/L is **tail-concentrated**: top 20% of winning conditions generate 82-92% of gross profit and require ~$8M cost basis to capture. At a $500/position cap we capture ~3% of swisstony's 16-day paper P/L for $3.1M of capital at risk; at $5,000/position cap we capture 22% for $12M at risk.

**The right next research move is to backfill Aug-Nov 2025 fills** (when RN1 and swisstony reportedly traded at smaller account size) and re-classify their strategy at that scale. If the tail-concentration was less severe at smaller account size, that's the copy-template our budget can replicate. The tools to do this backfill exist and are documented; see "Phase 1 — Backfill" below.

## Data inputs

All queries against `cogni-production-poly-postgres` via `scripts/grafana-postgres-query.sh`.

| wallet    | trader_wallet_id                       | wallet_address                               | earliest fill | latest fill | total fills | total $ |
| --------- | -------------------------------------- | -------------------------------------------- | ------------- | ----------- | ----------: | ------: |
| swisstony | `8c466f41-f6d0-4db2-b9fe-5c002b98f4fc` | `0x204f72f35326db932158cba6adff0b9a1da95e14` | 2026-04-30    | 2026-05-16  |     229,994 | $22.27M |
| RN1       | `a58df098-a862-4758-8954-7d14a2623ade` | `0x2005d16a84ceefa912d4e380cd32e7ff827875ea` | 2026-04-30    | 2026-05-16  |     230,030 | $20.98M |

**Coverage caveat:** despite spike.5024 backfilling for both wallets, only ~16 days of fill history exists in prod. The earlier `poly-dev-manager` skill card phrasing "walked from Apr" refers to _April 2026_, not 2025. The user's question about Aug-Nov 2025 behavior cannot be answered from current data and requires a new backfill run before any analysis.

## Last-7-day activity profile

| metric            | swisstony |     RN1 |
| ----------------- | --------: | ------: |
| BUY fills         |   129,267 | 117,114 |
| SELL fills        |     **0** |   **1** |
| Total $ volume    |   $12.36M | $10.97M |
| Unique conditions |     6,532 |   3,387 |
| Unique events     |     1,709 |   1,013 |
| Avg fill price    |    $0.509 |  $0.471 |
| Fills/day         |   ~18,500 | ~16,700 |

**Automated activity (≈ 1 fill every 5 seconds, 24/7).** Zero sells confirms exit-via-redemption-only.

## Hypothesis tests

### H1 — Neg-risk subsidy / converter capture: **secondary driver, not primary**

Neg-risk = 22-33% of activity:

| wallet    | neg_risk fills |   neg_risk $ | binary fills | binary $ |
| --------- | -------------: | -----------: | -----------: | -------: |
| swisstony |   43,208 (33%) | $4.82M (39%) |       86,059 |   $7.55M |
| RN1       |   25,541 (22%) | $2.65M (24%) |       91,629 |   $8.32M |

Avg fill price ~$0.50 on both buckets — does not match the "tail sub-cent over-priced NO" hypothesis.

### H2 — Market making / oscillation: **FALSIFIED**

0 SELL fills across 246,381 combined fills. No spread capture is possible without sells.

### H3 — Complete-basket arbitrage: **FALSIFIED (this is the correction)**

The original draft of this report claimed basket arbitrage based on:

- 94-99% of $ volume on conditions with both tokens held → **true**
- Median VWAP_a + VWAP_b ≈ $1.00 → **true but meaningless** (this is just market efficiency — any liquid binary's two sides always sum to ≈ $1)

The decisive test is **cost imbalance per paired condition**: `min(cost_a, cost_b) / max(cost_a, cost_b)`. A balanced basket has ratio ≈ 1.0; a directional bet with a small hedge has ratio << 1.

7-day data on paired conditions:

| wallet    | paired conds |    p10 |    **p50** |    p90 |  hedge <10% | hedge 10-50% |  hedge ≥50% |
| --------- | -----------: | -----: | ---------: | -----: | ----------: | -----------: | ----------: |
| swisstony |        4,439 | 0.0096 | **0.1846** | 0.7527 | 1,646 (37%) |  1,756 (40%) | 1,037 (23%) |
| RN1       |        2,478 | 0.0099 | **0.2332** | 0.7925 |   786 (32%) |  1,021 (41%) |   671 (27%) |

**Median hedge = 18-23% of primary; 32-37% of paired conditions have hedge <10%.** The strategy is directional, not arb. The "both tokens held" signature is the small hedge, not basket completeness.

This also aligns with the hardcoded bootstrap config in `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts`: `min_target_hedge_ratio = 0.02`, `max_hedge_fraction_of_position = 0.25` — defaults that assume the target hedges at 2-25% of primary. The defaults match the data.

### H4 — Directional bets with hedge: **CONFIRMED (primary mechanism)**

Conditions where they touched only one token in the 7d window — purely directional, no hedge:

| wallet    | conditions |  cost | cashPnl |     % |
| --------- | ---------: | ----: | ------: | ----: |
| swisstony |      2,097 | $552k | +$11.3k |  2.1% |
| RN1       |        817 | $217k | +$23.8k | 10.9% |

Small slice ($217-552k of $11-12M total cost), higher % return on RN1's single-side bets.

## P/L state (lifetime snapshots, captured since 2026-05-03)

| wallet    | positions | cost basis | current value | cashPnl | realizedPnl | winners | losers | redeemable |
| --------- | --------: | ---------: | ------------: | ------: | ----------: | ------: | -----: | ---------: |
| swisstony |    18,235 |    $18.52M |       $19.26M |  +$739k |      -$1.7k |   9,992 |  8,200 |      1,241 |
| RN1       |    14,481 |    $22.84M |       $22.29M |  -$549k | **+$1.04M** |   5,336 |  9,137 |      5,995 |

- **swisstony**: paper +$739k, almost nothing cashed (win-rate 55%).
- **RN1**: cashed +$1.04M realized; current paper mark -$549k (5,995 positions redeemable — in-flight resolution wave). Win-rate is 37%, but the +$1M realized confirms the strategy works.

## Per-condition shape

| metric      | swisstony |     RN1 |
| ----------- | --------: | ------: |
| Conditions  |    10,584 |  10,004 |
| Cost p50    |      $344 |    $170 |
| Cost p95    |    $7,170 | $12,021 |
| Cost p99    |   $19,994 | $33,791 |
| cashPnl p50 |    +$0.87 |  -$8.51 |
| cashPnl p95 |   +$1,589 | +$1,660 |
| cashPnl p99 |   +$6,519 | +$6,668 |

Median per-condition P/L ≈ $0; all edge lives in the right tail.

## Lorenz of P/L (positive-P/L conditions only)

| wallet    | positive conds |   top 1% P/L |       top 5% |      top 20% | top-20% cost |
| --------- | -------------: | -----------: | -----------: | -----------: | -----------: |
| swisstony |          6,295 | $1.75M (40%) | $2.95M (67%) | $4.03M (92%) |       $8.28M |
| RN1       |          3,236 |  $660k (20%) | $1.60M (49%) | $2.70M (82%) |       $8.56M |

Top 20% of winners → 82-92% of gross profit, requires ~$8M cost basis.

## Pareto budget simulation

For cap $B per position, captured P/L = `sum(min(B, their_cost) / their_cost × their_cashPnl)`.

### swisstony (16-day gross paper P/L = +$738,862)

|   Cap | Captured | % of edge | Capital at risk |
| ----: | -------: | --------: | --------------: |
|   $25 |     $915 |     0.12% |           $245k |
|   $50 |   $1,423 |     0.19% |           $464k |
|  $100 |   $2,647 |     0.36% |           $855k |
|  $250 |  $10,754 |     1.46% |          $1.83M |
|  $500 |  $23,002 |     3.11% |          $3.12M |
| $1000 |  $48,025 |     6.50% |          $5.10M |
| $2500 | $122,874 |    16.63% |          $8.79M |
| $5000 | $164,349 |    22.24% |         $12.00M |

### RN1 (16-day gross paper P/L = -$547,843 — underwater on mark)

|   Cap |  Captured | % of edge | Capital at risk |
| ----: | --------: | --------: | --------------: |
|   $25 |  -$62,727 |    11.45% |           $200k |
|  $100 | -$180,806 |    33.00% |           $670k |
|  $500 | -$445,410 |    81.30% |          $2.44M |
| $5000 | -$869,287 |   158.67% |         $10.75M |

RN1's paper P/L is currently negative (mark-to-market on unresolved baskets that may resolve favorably; see realized P/L above). Small caps lose proportionally faster because losers cluster at the small end of their cost distribution.

## What "scale linearly with capital" means (clarification)

Their P/L is **tail-concentrated**, not linear. The mechanism:

- Top 20% of winning conditions = 82-92% of gross profit, mean cost ~$4-7k per condition
- Bottom 80% of conditions contribute marginal P/L (median = $0)
- At a $500/position cap, the tail positions get clamped from ~$10-30k each → $500 each (20-60x reduction)
- We capture only 1/(20-60) of the tail's P/L → 3% overall

The cap doesn't break the strategy (each mirrored fill is still a fractional directional bet); it just **excludes us from the bets that actually pay**. That's the structural problem at our budget level.

## What this means for copy-trading today

### The fundamental constraint

The targets have evolved into a **capital-deployment strategy** — they need millions deployed across thousands of small-edge directional bets to generate meaningful absolute P/L. At our budget we can mirror their _shape_ but not their _scale_, and the tail-concentration means scale is where the edge actually lives.

### Three options ranked by feasibility

1. **Single-side filter + low-cap mirror** ($0.5-1M budget) — only mirror conditions where the target has touched one token; ignore the hedge legs. Captures the directional-only subset. Likely small absolute $ but capital-efficient on RN1 (10.9% return on the subset).
2. **Target re-selection** — find traders who concentrate edge in fewer, larger positions with higher % return per dollar. swisstony + rn1 are wrong-shape for our budget _as they currently trade_.
3. **Mirror their earlier behavior** — if they had a different shape at smaller account size (Aug-Nov 2025), that may be copyable. **Requires backfill — see Phase 1.**

## Confidence breakdown

**75% overall.** Falsified strategy classifications (basket arb) and identified data limits I missed initially (16-day fill window, not multi-month). New numbers:

| claim                                                          | confidence                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| 100% BUY / 0% SELL signature (exit via redemption only)        | 99%                                                        |
| Directional-with-small-hedge classification (median 18-23%)    | 90%                                                        |
| Tail-concentration of P/L (top 20% = 82-92%)                   | 90%                                                        |
| Pareto math is mechanically correct                            | 95%                                                        |
| Pareto interpretation ("$500 cap captures 3%") at current size | 80%                                                        |
| Strategic recommendation ("wrong targets at current size")     | 65% — depends on whether RN1's 2025 behavior was different |
| Backfill tools can extend history to Aug 2025                  | 95% — tools exist, idempotent, documented                  |

## Phase 1 — Aug-Nov 2025 backfill plan (executable today)

**Tools confirmed by `docs/guides/poly-target-backfill.md` + `scripts/experiments/poly-backfill/`:**

| step | script                                        | purpose                                                  |
| ---- | --------------------------------------------- | -------------------------------------------------------- |
| 1    | `walk.ts` (or `walk-windows.sh` orchestrator) | Walk Polymarket Data API `/activity?type=TRADE` backward |
| 2    | `load.ts`                                     | Idempotent NDJSON → `poly_trader_fills` via SSH tunnel   |
| 3    | `pnl-backfill.ts`                             | Backfill `poly_trader_user_pnl_points` (1h + 1d)         |
| 4    | (none — deployed ticks)                       | `runMarketOutcomeTick` + #1265 metadata writer fan-out   |

**Empirical sizing (per the guide):**

- RN1 averages ~27k fills/day → 9 months ≈ 7.3M fills per wallet
- 30-day window via 4 parallel sub-windows ≈ 10 min wall-clock walk
- 9 months × 2 wallets ≈ 90 min walk + 2-3 hour load
- Loader sustains ~1.6k rows/sec through SSH tunnel; idempotent on `(trader_wallet_id, source, native_id)`; tagged `raw.backfill_source = '<tag>'` so revert is `DELETE WHERE raw->>'backfill_source' = '<tag>'`.

**Concrete invocation for RN1 priority (per user direction — they have the more consistent P/L curve):**

```bash
# 0. Open SSH tunnel to candidate-a (or production once validated on candidate-a)
KEY=~/dev/cogni-template/.local/candidate-a-vm-key
IP=$(cat ~/dev/cogni-template/.local/candidate-a-vm-ip)
ssh -i "$KEY" -f -N -L 55433:localhost:5432 root@"$IP"

# 1. Walk RN1 fills Aug 1 2025 → Apr 30 2026 (where current data starts)
./scripts/experiments/poly-backfill/walk-windows.sh \
  --wallet RN1 --start 2025-08-01 --end 2026-04-30 \
  --windows 9 --max-pages-per-window 2000 \
  --out /tmp/poly-backfill/rn1-aug25

# 2. Load into candidate-a (NOT production yet — validate on candidate-a first per guide §"Production / preview SSH access")
PGPASS=$(grep POSTGRES_ROOT_PASSWORD .env.canary | cut -d"'" -f2)
DATABASE_URL_POLY="postgresql://postgres:${PGPASS}@localhost:55433/cogni_poly" \
  pnpm tsx --max-old-space-size=2048 \
  scripts/experiments/poly-backfill/load.ts \
  --in /tmp/poly-backfill/rn1-aug25/rn1-fills.ndjson \
  --wallet-address 0x2005d16a84ceefa912d4e380cd32e7ff827875ea \
  --source-tag swisstony-rn1-2025-research \
  --apply

# 3. Extend pnl points
DATABASE_URL_POLY="postgresql://postgres:${PGPASS}@localhost:55433/cogni_poly" \
  pnpm tsx scripts/experiments/poly-backfill/pnl-backfill.ts \
  --wallet-address 0x2005d16a84ceefa912d4e380cd32e7ff827875ea --apply

# 4. Wait for runMarketOutcomeTick + #1265 metadata writer to fan out to new conditions
#    Watch: event="poly.market-outcome.tick.ok" + event="poly.market-price-history.tick_ok"

# 5. Repeat steps 1-3 for swisstony (0x204f72f35326db932158cba6adff0b9a1da95e14)
```

**Constraints (from the guide):**

- Validate on candidate-a first; do NOT load to production until candidate-a is 24h+ stable post-load
- Walker's `--max-pages-per-window` is the rate-limit safety; the guide reports no token-bucket observed on Polymarket Data API at 30 concurrent, but the per-window cap keeps us polite
- Source-tag the load so revert is one-line SQL

## Phase 2 — Comparative analysis after backfill (SQL aggregates, no V8 hydration per data-research skill)

For each of {Aug 2025, Sep 2025, Oct 2025, Nov 2025, May 2026} compute the same metrics so we can plot evolution:

1. **Position-size distribution per condition** — p50/p75/p90/p95/p99 of `running_cost = SUM(size_usdc) OVER (PARTITION BY wallet, condition, token ORDER BY observed_at)` at end-of-month. Tests: was median position $20 in Aug 2025 vs $170 now?
2. **Hedge imbalance per condition** — same `min/max(cost)` ratio computed within month boundaries. Tests: was the hedge ratio always 18-23%, or did it scale up with capital?
3. **Tail concentration (lorenz)** — top 1%/5%/20% share of monthly cashPnl. Tests: was the top 5% always > 50% of profit, or was P/L more evenly distributed at smaller scale?
4. **Win-rate per dollar at risk** — `SUM(payout - cost) / SUM(cost)` per month, payout derived from `poly_market_outcomes`. Tests: did edge per dollar shrink as they scaled, or stay constant?
5. **Market characteristics** — joined to `poly_market_metadata`: were they betting smaller / less-liquid / different event types in 2025? Neg-risk share?
6. **Hold time** — `resolved_at - first_fill_at` per condition. Tests: hold-to-resolution was the pattern from day one?
7. **Pareto budget simulation per-month** — apply the same cap sweep using _then-current_ P/L. The headline question: was there a window where $500/position cap captured >30% of their edge?

All queries follow `data-research` skill: SQL-aggregated, EXPLAIN'd against the largest expected dataset, p95 < 200ms.

## Phase 3 — Conclusion + actionable copy-trade design

If **Aug-Nov 2025 RN1** showed: (a) median position $50-200, (b) hedge ratio similar to now, (c) tail concentration <50% in top 5%, (d) consistent monthly edge per dollar → **that's the copy template for our budget.** Concrete next step: implement a "basket-completeness-aware mirror filter" in `mirror-coordinator` that emits decisions only on the directional leg of paired-token positions, scoped to position sizes ≤ $X (where $X is derived from the historical distribution).

If Aug-Nov RN1 already showed tail-concentration with $5k+ winners driving everything → **the targets were never copyable at our scale.** Switch focus to target screening: query `poly_trader_wallets` + Polymarket `/leaderboard` for candidates with: high realized PnL per dollar, low fill count (sub-1000/week), low max position size (<$1k), positive 90-day realized.

## Citations

- bug.5012 (poly OOM crashloop) — driver of the SQL-aggregation discipline
- spike.5024 — historical fill walker, NDJSON pattern, idempotent loader
- `docs/guides/poly-target-backfill.md` — operator runbook used in Phase 1
- `docs/research/poly/backfill-spike-2026-05-05.md` — architecture record
- `data-research` skill — PAGE_LOAD_DB_ONLY, SQL-aggregation, primitive vs decision-relevant
- `poly-dev-manager` skill — neg-risk converter mechanics, basket-arb framing (which led me astray initially)
- `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts` — hedge-ratio defaults match the data

#poly #copy-target-analysis #directional-with-hedge #pareto #target-selection #swisstony #rn1 #backfill-plan #tail-concentration
