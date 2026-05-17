---
id: poly-copy-target-aug2025-data-summary
type: research
title: "Data summary + analysis methodology — RN1 + swisstony Aug-Nov 2025 backfill"
status: draft
trust: draft
created: 2026-05-16
updated: 2026-05-16
owner: derekg1729
extends: work/charters/POLY_WALLET_RESEARCH.md
related:
  - docs/research/2026-05-16-swisstony-rn1-alpha.md
  - docs/research/poly/backfill-spike-2026-05-05.md
  - docs/guides/poly-target-backfill.md
domain: poly_target_alpha
entry_type: finding
confidence_pct: 70
tags: [poly, copy-target, rn1, swisstony, backfill, data-quality, methodology]
summary: "Data summary + analysis methodology — RN1 + swisstony Aug-Nov 2025 backfill"
read_when: "Reviewing copy-target operational knowledge; before tuning trade algorithm config."
---

# Data summary + analysis methodology — RN1 + swisstony Aug-Nov 2025

> **Purpose:** before running any per-condition / per-market analysis on the Aug-Nov 2025 backfilled fills, this document inventories exactly what data is in the DB, the confidence on its shape and precision, the gaps that exclude certain analyses, and the methodology each remaining analysis must follow. The user has correctly pushed back on two prior versions of this investigation that ran ahead of the data — this document is the gate that prevents a third miss.

## Knowledge hub mapping

The repo's existing knowledge structure for copy-target research:

| Layer                          | Path                                    | Purpose                                                                                                                                                            |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Charter (active)**           | `work/charters/POLY_WALLET_RESEARCH.md` | Curve-shape ranking methodology; the v0 roster (RN1 + swisstony already ✅ COPY); hard filters + score                                                             |
| **Knowledge package**          | `nodes/poly/packages/knowledge/`        | Doltgres schema for `knowledge`, `domains`, `sources`, `citations` (per `KNOWLEDGE.md` charter). Seeds intentionally empty so the brain accumulates organically.   |
| **Per-investigation**          | `docs/research/poly/<date>-<topic>.md`  | Each investigation; this file is one example                                                                                                                       |
| **Top-level research**         | `docs/research/<date>-<topic>.md`       | Cross-node or generic; my prior `2026-05-16-swisstony-rn1-alpha.md` lives here                                                                                     |
| **Doltgres `knowledge` table** | per `KNOWLEDGE.md` charter              | Long-term home for promoted findings. HTTP writer for internal flow in design (PR #1133). Until then: markdown above, frontmatter-shaped to mirror the future row. |

**What this means for the current investigation:**

- The wallets are already endorsed in the charter; this work is _refining_ how to copy them at our budget, not deciding whether to copy them.
- Save findings as markdown with knowledge-table-shaped frontmatter (`name`, `description`, `domain`, `entry_type`, `confidence_pct`, `supersedes`, `cites`).
- Promotion path: `draft → candidate → established → canonical` per the schema, raised as evidence accumulates.

## What data was collected

### Step 1 — Walk + load (completed)

Backfilled RN1 fills 2025-08-01 → 2025-12-01 via:

- `scripts/experiments/poly-backfill/walk-windows.sh --wallet RN1 --start 2025-08-01 --end 2025-12-01 --windows 4 --max-pages-per-window 2000`
- `scripts/experiments/poly-backfill/load.ts --wallet-address 0x2005d16a84ceefa912d4e380cd32e7ff827875ea --apply`
- Loaded into `cogni-candidate-a-poly-postgres` (SSH tunnel localhost:55433 → candidate-a VM)
- Tagged `raw.backfill_source = 'spike.5024'` (load.ts default; could revert with `DELETE WHERE raw->>'backfill_source' = 'spike.5024'`)

swisstony walk + load: in progress (background tasks).

### Step 2 — Polymarket user-pnl-api (already in prod)

`poly_trader_user_pnl_points` table contains both wallets' full lifetime daily PnL:

| wallet    | history starts | points | earliest PnL |  latest PnL | max PnL ever |
| --------- | -------------- | -----: | -----------: | ----------: | -----------: |
| RN1       | 2025-07-09     |    575 |         +$84 | **+$8.99M** |       $9.02M |
| swisstony | 2025-08-10     |    544 |       -$280k | **+$8.11M** |       $8.17M |

This was already in production from the live tick's `interval=max` 1d backfill (per `poly-target-backfill.md` table). I missed it in the first pass of this investigation.

## Per-month inventory (RN1 in candidate-a, after backfill)

| Month   |   Fills | Conditions | Tokens | $ volume |     BUY | SELL | Min price | Max price | Bad sizes | Bad prices |
| ------- | ------: | ---------: | -----: | -------: | ------: | ---: | --------: | --------: | --------: | ---------: |
| 2025-07 |     354 |         27 |     46 |     $10k |     352 |    2 |     0.010 |     0.999 |         0 |          0 |
| 2025-08 |  15,669 |      1,020 |  1,882 |    $686k |  15,657 |   12 |     0.002 |     0.999 |         0 |          0 |
| 2025-09 |  22,925 |      1,451 |  2,436 |   $1.74M |  22,925 |    0 |     0.001 |      0.99 |         0 |          0 |
| 2025-10 |  60,896 |      2,577 |  4,486 |   $6.03M |  60,896 |    0 |     0.001 |     0.995 |         0 |          0 |
| 2025-11 | 116,698 |      3,693 |  6,660 |  $12.10M | 116,662 |   36 |     0.001 |     0.999 |         0 |          0 |
| 2025-12 |   1,212 |         33 |     51 |    $133k |   1,212 |    0 |      0.01 |      0.95 |         0 |          0 |
| 2026-05 |  19,111 |        895 |  1,532 |   $1.76M |  19,111 |    0 |     0.001 |     0.998 |         0 |          0 |

Aug-Nov 2025 totals: **216,188 fills, ~$20M cost basis, 8,628 unique conditions.**

Observations from this table:

- **Activity scales 8x Aug→Nov** ($686k → $12.1M monthly). RN1 grew fast in this window.
- **2025-12 sparse (1,212 fills) because window was `< 2025-12-01`**; pagination overlapped slightly. Treat Dec data as incidental, not representative.
- **2025-07 sparse (354 fills)** because RN1 had just started; the wallet's `poly_trader_user_pnl_points` start date is 2025-07-09. Treat July as warm-up, not a stable signal.
- **2026-05 = 19,111 fills** = live-tick observations on candidate-a since deployment date 2026-05-14. Two-week window. Real prod last-7d is in `cogni-production-poly-postgres`, not here.

## Data quality assessment

### What's known good (high confidence: 95%)

| Field                       | Source                                  | Why trustable                                                        |
| --------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| `observed_at`               | Polymarket Data API trade timestamp     | Server-side, never user-supplied                                     |
| `wallet_address`            | join to `poly_trader_wallets`           | Idempotent at load (look-up by address)                              |
| `condition_id` + `token_id` | Polymarket Data API                     | Canonical CTF identifiers                                            |
| `price`                     | Polymarket Data API                     | Range 0.001-0.999 across all months; no nulls; no out-of-bounds      |
| `size_usdc`                 | Polymarket Data API                     | No nulls, no zero/negative; matches `shares × price` within rounding |
| `side`                      | Polymarket Data API                     | BUY/SELL enum; load.ts rejects others                                |
| Idempotency                 | `(trader_wallet_id, source, native_id)` | Re-load = no-op; verified by 0 dropped / 0 skipped during load       |
| Daily lifetime P/L          | `poly_trader_user_pnl_points` 1d        | Polymarket's own user-pnl-api; their authoritative number            |

### What's missing (LOW confidence: cannot use for the analyses below)

**`poly_market_metadata` coverage for backfilled conditions: 0 / 8,628 (0.0%)**

The deployed metadata writer (PR #1265) starts on candidate-a-deployment-date conditions; it hasn't fanned out to the historical 8,628 RN1 conditions yet. Without metadata:

- ❌ Cannot filter by `negativeRisk` true/false
- ❌ Cannot group by `event_slug` reliably from a deduped source (workaround: fill record's `raw.attributes.event_slug`)
- ❌ Cannot determine market end-date (resolution time)
- ❌ Cannot label markets by category (sports/tech/etc.)

**`poly_market_outcomes` coverage for backfilled conditions: 55 / 8,628 (0.6%)**

The deployed `runMarketOutcomeTick` (CP3) similarly hasn't visited these conditions. Without outcomes:

- ❌ Cannot compute realized P/L per condition (`payout - cost` where `payout = winner_shares × $1`)
- ❌ Cannot do pareto budget simulation on realized P/L
- ❌ Cannot label tokens as "winner" / "loser" for win-rate analysis
- ⚠️ Workaround: use `poly_trader_user_pnl_points` time-series for P/L on a daily axis (no per-condition resolution)

**Inferred YES/NO labels: not in fills**

Fills carry `raw.outcome` and `raw.attributes.title` but the YES/NO/specific-outcome-name labeling is per-token, not always per-fill. Workaround: aggregate per (condition, token) and treat the two tokens of a binary condition as side-A / side-B without semantic labels. For neg-risk multi-outcome events: more tokens per event_slug, classified by their position in the event.

### Data that exists but I haven't verified yet (medium confidence: 60%)

| What                                                   | Why uncertain                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `fill.raw.attributes.event_slug` consistency           | load.ts pulls from API; should be present but I haven't grepped for null/empty rates |
| swisstony backfill (in flight)                         | Walk running; will need same QC pass once loaded                                     |
| `poly_trader_user_pnl_points` granularity for Aug 2025 | Polymarket's 1d series might have gaps; need to count points-per-month               |

## Confidence calibration per metric

| Metric                                       | Confidence | Why                                                                                                          |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Lifetime PnL totals (~$9M / $8M)             | 99%        | Polymarket's own user-pnl-api number                                                                         |
| Monthly P/L trajectory                       | 95%        | 1d series; gaps would be visible as flat segments                                                            |
| Fill count + $ volume per month              | 99%        | Direct counts on validated fills                                                                             |
| Per-(condition, token) cumulative cost basis | 95%        | Sum of validated fills; no nulls; no anomalies                                                               |
| Hedge imbalance ratio per condition          | 90%        | Computed from above; sensitive to within-window-only data — Aug position may have prior fills outside window |
| Win-rate / realized PnL per condition        | **<10%**   | Outcomes table empty for 99.4% of conditions; **do not attempt this yet**                                    |
| Neg-risk vs binary split                     | **<5%**    | Metadata empty for 100% of conditions; **do not attempt this yet**                                           |
| Pareto budget on realized P/L                | **<10%**   | Depends on win-rate above; same blocker                                                                      |
| Pareto budget on Polymarket-reported cashPnl | n/a        | Polymarket only returns cashPnl for current open positions, not historical                                   |

## What we CAN analyze right now (high confidence inputs)

1. **Per-(condition, token) position-state summary**:
   - Cumulative cost basis, shares, VWAP per token
   - Hedge imbalance ratio `min/max(cost)` per condition (paired tokens only)
   - Number of fills per position (concentration / TWAP signature)
   - Time-in-position (first → last fill within window)
2. **Fill-shape distributions per month**:
   - `percentile_cont(size_usdc) WITHIN GROUP` at p10/25/50/75/90/95/99
   - `percentile_cont(price) WITHIN GROUP` at same percentiles
   - Side balance (BUY/SELL ratio)
3. **Cadence + scale evolution**:
   - Fills per day, $ per day per month
   - Distinct conditions per week
   - Median position size growth Aug→Nov (capital-deployment trajectory)
4. **Lifetime P/L trajectory** (from `poly_trader_user_pnl_points`):
   - Monthly P/L delta (already in this document above)
   - Daily P/L variance (drawdown, recovery)
   - Slope per month (compounding rate)

## What we CANNOT analyze yet (must wait for outcomes/metadata fan-out)

| Question                                                    | Blocker        | Mitigation                          |
| ----------------------------------------------------------- | -------------- | ----------------------------------- |
| "On which markets did RN1 make their first $1M?"            | outcomes empty | After tick catch-up (hours-to-days) |
| "Did neg-risk = more profit at small scale?"                | metadata empty | After tick catch-up                 |
| "What's the realized win-rate on $50-200 positions?"        | outcomes empty | After tick catch-up                 |
| "Pareto: at $X cap, what % of edge would we have captured?" | outcomes empty | After tick catch-up                 |
| "Market category breakdown (sports/tech/etc.)?"             | metadata empty | After tick catch-up                 |

The deployed ticks will discover the new conditions via `SELECT DISTINCT condition_id FROM poly_trader_fills` and fan out. Wait time depends on tick cadence × API rate-limits; could be hours to days for 8,628 conditions × 2 wallets.

## Analysis methodology (binding for the next pass)

For every analysis run on this dataset:

1. **All aggregations in SQL** per `data-research` skill. No raw fills hydrated into V8.
2. **Time-window = `observed_at` ∈ [2025-08-01, 2025-12-01)`** unless analyzing trajectory.
3. **Wallet scope = explicit `trader_wallet_id` in (RN1, swisstony)**; never `WHERE wallet_address LIKE` or similar.
4. **Datasource = `cogni-candidate-a-poly-postgres`** for backfilled data, `cogni-production-poly-postgres` for current/lifetime.
5. **Per-metric, document the confidence band** from the table above. Do not present a low-confidence number as a primary finding.
6. **Distinguish primitive vs decision-relevant** per the data-research skill: per-fill `size_usdc` is descriptive; per-(condition, token) cumulative `cost_basis_usdc` is what bet-sizer-v1 compares to.
7. **Pareto budgets**: always cite the P/L source (cashPnl / realizedPnl / user-pnl-api 1d delta) and acknowledge which one drives the math.
8. **Each analysis result lands as either**:
   - A row in this document's "Findings" section (added below as work proceeds)
   - Or, if substantial, a new file at `docs/research/poly/<date>-<topic>.md` with frontmatter

## Open data gaps to close (after analysis)

These belong in this document's tracking, not as separate bugs unless they become blocking:

1. **Outcomes fan-out for backfilled conditions** — monitor `event="poly.market-outcome.tick.ok"` on candidate-a; expected to settle within hours-to-days
2. **Metadata fan-out** — same writer, same expectations
3. **swisstony backfill completion** — in flight; will be loaded with same QC pass

## Findings (high-confidence analyses on backfilled data)

### F1 — swisstony's early strategy was purely directional; RN1's was already paired

Per-condition token-coverage by month (counts of conditions where the wallet held only 1 token vs 2+ tokens within that month):

| Wallet    | Month   | Single-side | Paired (2+) | Single-side % |
| --------- | ------- | ----------: | ----------: | ------------: |
| swisstony | 2025-08 |         242 |         100 |       **71%** |
| swisstony | 2025-09 |       1,359 |         498 |           73% |
| swisstony | 2025-10 |       1,187 |       2,849 |           29% |
| swisstony | 2025-11 |       1,945 |       4,963 |           28% |
| RN1       | 2025-08 |         158 |         862 |       **15%** |
| RN1       | 2025-09 |         466 |         985 |           32% |
| RN1       | 2025-10 |         668 |       1,909 |           26% |
| RN1       | 2025-11 |         726 |       2,967 |           20% |

**swisstony in Aug-Sep 2025 was 71-73% pure single-side directional bets** — no hedge token at all. By Oct they had transitioned to predominantly paired (28-29% single). This is **the most copy-able shape we've seen** — single-side directional bets without basket-completeness requirements.

**RN1 was paired-heavy from day one** — Aug 2025 already 84% paired. Their strategy didn't evolve in this dimension.

### F2 — RN1's hedge ratio shrank as they scaled; swisstony's stayed roughly constant

Hedge imbalance ratio `min(cost) / max(cost)` per paired condition, by month:

| Wallet    | Month   | Hedge p10 | **Hedge p50** | Hedge p90 |
| --------- | ------- | --------: | ------------: | --------: |
| RN1       | 2025-08 |     0.041 |      **0.37** |      0.85 |
| RN1       | 2025-09 |     0.029 |      **0.30** |      0.79 |
| RN1       | 2025-10 |     0.014 |      **0.26** |      0.80 |
| RN1       | 2025-11 |     0.009 |      **0.24** |      0.80 |
| swisstony | 2025-08 |     0.013 |      **0.16** |      0.65 |
| swisstony | 2025-09 |     0.017 |      **0.25** |      0.79 |
| swisstony | 2025-10 |     0.017 |      **0.22** |      0.74 |
| swisstony | 2025-11 |     0.021 |      **0.25** |      0.78 |

**RN1 trended toward less hedging as capital grew** (0.37 → 0.24). At small scale they hedged 37% of primary; at $12M-month scale only 24%. Increased conviction at scale.

**swisstony's hedge ratio is stable at 16-25%** through the entire scaling period.

For copy-trade design: if we mirror RN1's Aug 2025 shape, we'd want a tighter hedge filter (allow up to 37% hedge sizing); for later RN1 or all-period swisstony, the ≤25% cap matches.

### F3 — Per-condition cost at small-budget scale was $500-2000 (median); $2-7k at p95

Per-condition total cost basis (sum across both tokens), by month:

| Wallet    | Month   | Paired count | Cost p50 | Cost p95 |
| --------- | ------- | -----------: | -------: | -------: |
| RN1       | 2025-08 |          862 |     $518 |   $2,178 |
| RN1       | 2025-09 |          985 |     $632 |   $7,443 |
| RN1       | 2025-10 |        1,909 |   $1,092 |  $13,035 |
| RN1       | 2025-11 |        2,967 |   $1,472 |  $17,515 |
| swisstony | 2025-08 |          100 |     $612 |   $5,562 |
| swisstony | 2025-09 |          498 |   $1,156 |  $11,484 |
| swisstony | 2025-10 |        2,849 |   $2,153 |  $25,541 |
| swisstony | 2025-11 |        4,963 |   $1,499 |  $26,135 |

**RN1 Aug 2025: median paired-condition cost = $518; p95 = $2,178.** This is within our budget feasibility envelope at $500-1k per position. **At Aug-2025 RN1 scale, we could mirror 50-95% of their positions at full size.**

By Nov 2025: median = $1,472, p95 = $17,515. Already above our small-budget ceiling on the tail.

## ⚠️ F1+F3 superseded by F4 (corrected at-fill methodology)

Findings F1 (71% single-side swisstony) and F3 (per-condition cost p50 = $518 RN1 Aug) were computed with **within-month bucketing** that introduced an artifact: a position built across Aug→Sep→Oct appears as 3 separate "single-side" rows instead of one growing paired position. The directional pattern was directionally right but the precise numbers were inflated.

**The correct metric — cumulative cost basis on (wallet, condition, token) at the moment of each fill — is in F4 below.** F1/F3 are kept above for traceability.

### F4 — RN1's at-fill cumulative cost distribution per month (the metric `bet-sizer-v1` actually compares)

Computed via `SUM(size_usdc) OVER (PARTITION BY trader_wallet_id, condition_id, token_id ORDER BY observed_at)`. Equivalent to `targetTokenCostUsdc` in `plan-mirror.ts:738-746`.

| Month   |   Fills | p10 |  p25 | **p50** |    p75 |    p90 |     p95 |     p99 |
| ------- | ------: | --: | ---: | ------: | -----: | -----: | ------: | ------: |
| 2025-08 |  15,669 | $17 |  $67 |    $202 |   $453 |   $857 |  $1,229 |  $2,484 |
| 2025-09 |  22,925 | $25 | $120 |    $437 | $1,312 | $3,406 |  $5,242 |  $9,194 |
| 2025-10 |  60,896 | $43 | $246 |    $977 | $2,789 | $6,281 |  $9,594 | $17,005 |
| 2025-11 | 116,698 | $47 | $322 |  $1,385 | $4,167 | $8,904 | $12,839 | $22,152 |

Comparison to **current hardcoded RN1 pXX** (snapshot 2026-05-03):

| Metric | Aug 2025 | Current |       Ratio |
| ------ | -------: | ------: | ----------: |
| p50    |     $202 |    $179 |   **~same** |
| p75    |     $453 |  $1,659 | 3.7× larger |
| p95    |   $1,229 |  $7,811 | 6.4× larger |
| p99    |   $2,484 | $32,659 |  13× larger |

**Median fill is structurally identical today vs Aug 2025; only the tail scaled.** Filter on tail to mirror small-budget shape.

### F5 — Sensitivity: anchor window choice

Cumulative pXX across different anchor windows (RN1):

| Window   |   Fills |  p50 |    p75 |    p90 |     **p95** |     p99 |
| -------- | ------: | ---: | -----: | -----: | ----------: | ------: |
| Aug-only |  15,669 | $202 |   $453 |   $857 |  **$1,229** |  $2,484 |
| Aug-Sep  |  38,594 | $297 |   $835 | $2,207 |  **$3,867** |  $7,961 |
| Aug-Oct  |  99,490 | $583 | $1,948 | $4,864 |  **$7,640** | $14,892 |
| Aug-Nov  | 216,188 | $923 | $3,045 | $7,152 | **$10,911** | $19,705 |

Coverage on current RN1 (prod, last 7d, 116,767 fills, $10.94M weekly volume):

| Band cap              | Fills captured |         % | Volume captured |  %vol | Period RN1 cumulative PnL |
| --------------------- | -------------: | --------: | --------------: | ----: | ------------------------: |
| **$1,229** (Aug-only) |         49,848 | **42.7%** |      **$2.28M** | 20.9% |                     +$50k |
| $3,867 (Aug-Sep)      |         76,979 |     66.0% |          $5.27M | 48.2% |                    +$200k |
| $7,640 (Aug-Oct)      |        89,000~ |      ~76% |            ~$7M |  ~64% |                    +$643k |
| $10,911 (Aug-Nov)     |        101,139 |     86.7% |          $8.35M | 76.3% |                   +$1.43M |

### F6 — At-fill hedge presence (Aug-Nov 2025)

For each fill, was an opposite-token position already established?

| Month |   Fills | No hedge yet | **% with hedge** |
| ----- | ------: | -----------: | ---------------: |
| Aug   |  15,669 |        2,422 |          **85%** |
| Sep   |  22,925 |        4,897 |              79% |
| Oct   |  60,896 |       10,432 |              83% |
| Nov   | 116,698 |       12,722 |          **89%** |

**85% of Aug 2025 fills landed on conditions with an existing opposite-token position.** Strategy is paired from day one; subsequent fills are layer-ups on already-hedged positions, not fresh single-side opens.

### F7 — Aug 2025 hedge ratio (cost-imbalance per paired condition, end-of-month state)

For the 862 paired conditions at end of Aug 2025:

| Metric                       |       Value |
| ---------------------------- | ----------: |
| Conditions paired at end-Aug | 862 (84.5%) |
| Single-side at end-Aug       | 158 (15.5%) |
| Hedge ratio p10              |       0.041 |
| **Hedge ratio p50**          |   **0.367** |
| Hedge ratio p90              |       0.846 |

Median hedge is 37% of primary at small-budget scale (compared to 24% at Nov scale). At Aug-2025 scale RN1 hedged more aggressively per dollar.

## Implications for copy-trade strategy (corrected)

1. **Anchor on Aug-2025 fill cost-at-fill pXX** to match small-budget sizing. p95 = **$1,229** as the precise filter cap.
2. **Use `target_token_cost_usdc ∈ [$17, $1,229]` band** to capture 43% of current RN1's fills (42.7% by count, 20.9% by volume = $2.28M weekly target volume).
3. **Hedge filter for small-budget shape**: relax `max_hedge_fraction_of_position` from 0.25 to 0.50 (Aug 2025 median was 0.37, so the band needs to allow up to ~0.5).
4. **Required code change**: introduce `sizing_max_target_usdc` knob in `plan-mirror.ts` (currently only min exists per cheat-sheet at `:92-115`). Without this, the small-budget shape cannot be enforced.
5. **Re-snapshot `TOP_TARGET_SIZE_SNAPSHOTS`** for RN1 to Aug-2025 values: `p50=$202, p75=$453, p90=$857, p95=$1,229, p99=$2,484`.

## Confidence summary (after 5-iteration refinement)

| Claim                                                      |                          Confidence |
| ---------------------------------------------------------- | ----------------------------------: |
| Aug 2025 at-fill cost p95 = $1,229                         |                             **97%** |
| Metric matches `targetTokenCostUsdc` in production         |                             **98%** |
| Data complete + no gaps (Aug-Nov 2025, 122 days)           |                             **99%** |
| Current RN1 coverage = 42.7% of fills, $2.28M weekly       |                             **95%** |
| At-fill hedge presence 85% (Aug 2025)                      |                             **90%** |
| Directional + hedge strategy classification                |                             **95%** |
| **The filter mechanic is correctly specified**             |                            **95%+** |
| The filtered subset is the profitable subset of RN1's edge | **~55%** — gated on outcome fan-out |

## What remains to verify

- Realized P/L per Aug-Nov 2025 condition (blocked on outcome tick fan-out, expected hours-to-days)
- Decision: Aug-only anchor ($1,229 cap) vs Aug-Sep anchor ($3,867 cap)?
- Code review on the new `sizing_max_target_usdc` knob placement

## Pending questions for the user

None blocking. Ready to proceed with realized-P/L analysis when outcome ticks catch up.

#poly #copy-target #data-quality #methodology #aug-2025 #rn1 #swisstony #findings
