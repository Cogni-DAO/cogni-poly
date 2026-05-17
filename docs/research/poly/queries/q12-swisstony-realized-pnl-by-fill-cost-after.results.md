---
id: poly.research.queries.q12-swisstony-realized-pnl-by-fill-cost-after.results
type: research
title: "Results history — q12-swisstony-realized-pnl-by-fill-cost-after"
summary: "Run-by-run results for query q12-swisstony-realized-pnl-by-fill-cost-after — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q12 results — swisstony fill-level winner rate by cost_after

Run 1 — 2026-05-16 ~23:05 UTC:

| Bucket (cost_after) | Fills |   Cost | Winner fills | **Winner %** | EV at $0.50 |
| ------------------- | ----: | -----: | -----------: | -----------: | ----------: |
| ≤ $100              | 4,734 |   $69k |        2,190 |       46.26% |       -7.5% |
| $100-$545           | 6,294 |  $332k |        3,131 |       49.75% |       -0.5% |
| $545-$1,229         | 4,154 |  $426k |        2,155 |   **51.88%** |       +3.8% |
| $1,229-$5,000       | 8,327 | $1.37M |        4,688 |   **56.30%** |      +12.6% |
| > $5,000            | 7,502 | $2.90M |        4,513 |   **60.16%** |      +20.3% |

## ⚠️ Disagreement with Q07 (condition-level)

Q07 condition-level showed swisstony's BARBELL profile:

- ≤$100 conditions: +11% return
- > $5,000 conditions: +14% return
- Middle bands: weak

Q12 fill-level shows MONOTONIC INCREASING winner rate (46% → 60%).

### Why the disagreement is informative

A condition with `total_cost ≤ $100` typically had only 1-3 small fills — they're SMALL FINAL POSITIONS. In the resolved subset, the small ones that DID resolve and DID win contribute positive P/L.

A fill with `cost_after ≤ $100` is just the EARLY part of a position that may grow. Many of these later get layered into larger positions. The "winner %" at this fill-level is what the production algorithm sees at decision time, and that's the relevant number for gating.

**For copy-trade design, Q12 wins over Q07.**

## Revised swisstony config

```ts
{
  wallet: "swisstony",
  sizing_min_target_usdc: 1229,        // CHANGED — was 25; need 51%+ winner rate
  sizing_max_target_usdc: 8000,        // CHANGED — was 100; their edge extends through >$5k
  max_usdc_per_condition: 30,          // unchanged
}
```

**But at $1k budget**: swisstony's strongest edge is in the >$5k cost_after range where we can't take meaningful proportional positions. **swisstony is the wrong target at our budget level.** Focus mirror on RN1.

## Comparison RN1 vs swisstony fill-level winner rate

| Bucket          |  RN1 (Q11) | swisstony (Q12) | Better target                          |
| --------------- | ---------: | --------------: | -------------------------------------- |
| ≤ $100          |     38.86% |          46.26% | swisstony (but both < 50%)             |
| $100-$545       |     46.74% |          49.75% | swisstony (still below 50%)            |
| **$545-$1,229** | **53.94%** |          51.88% | **RN1 — best in budget-feasible band** |
| $1,229-$5,000   |     53.07% |          56.30% | swisstony — but barely affordable      |
| > $5,000        |     46.92% |          60.16% | swisstony — out of budget              |

**At our $1k budget, RN1 has the better risk-adjusted edge** in the band we can actually mirror.
