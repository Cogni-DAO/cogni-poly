---
id: poly.research.queries.q11-rn1-realized-pnl-by-fill-cost-after.results
type: research
title: "Results history — q11-rn1-realized-pnl-by-fill-cost-after"
summary: "Run-by-run results for query q11-rn1-realized-pnl-by-fill-cost-after — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q11 results — CROSS-VALIDATION ANCHOR

Run 1 — 2026-05-16 ~22:55 UTC:

| Bucket (cost_after) | Fills |  Cost | Winner fills | **Winner %** | Implied EV at $0.50 |
| ------------------- | ----: | ----: | -----------: | -----------: | ------------------: |
| ≤ $100              | 3,219 |  $42k |        1,251 |   **38.86%** |            **-11%** |
| $100-$545           | 4,247 | $224k |        1,985 |   **46.74%** |                 -3% |
| $545-$1,229         | 2,792 | $271k |        1,506 |   **53.94%** |             **+4%** |
| $1,229-$5,000       | 5,095 | $655k |        2,704 |   **53.07%** |             **+3%** |
| > $5,000            | 3,067 | $595k |        1,439 |   **46.92%** |                 -3% |

## Why this query is more trustworthy than Q06

Q06 buckets by **condition's total_cost** (final state). Q11 buckets by **fill's cost_after** (the moment-of-fill state, which is what the production algorithm `bet-sizer-v1` actually sees). Two reasons Q11 is more decision-relevant:

1. **Matches the algorithm's decision boundary.** When `plan-mirror.ts` evaluates a new target fill, it computes `targetTokenCostUsdc` = cumulative cost on that token (= `cost_after` in this query). It does NOT have knowledge of the condition's future final state.

2. **Stable against outcome-resolution drift.** Q06 bucketed conditions by total final cost. As more conditions resolve, the cost distribution shifts. Q11 buckets fills (already observed, fixed cost_after at observation time); the only thing that moves with resolution fan-out is the outcome label, which simply adds samples to existing buckets.

## Cross-validation with Q06

| Bucket        | Q06 (condition % return) | Q11 (fill winner %) | Agreement                                          |
| ------------- | -----------------------: | ------------------: | -------------------------------------------------- |
| ≤ $100        |                   +5.97% |    38.86% → -11% EV | ⚠️ DISAGREE — Q06 says positive, Q11 says negative |
| $100-$545     |                   +5.12% |     46.74% → -3% EV | ⚠️ DISAGREE — same issue                           |
| $545-$1,229   |                   +7.63% |     53.94% → +4% EV | ✅ Both positive                                   |
| $1,229-$5,000 |                   +8.88% |     53.07% → +3% EV | ✅ Both positive                                   |
| > $5,000      |                   +0.17% |     46.92% → -3% EV | ⚠️ Q06 ~0, Q11 negative                            |

The disagreement is informative. Q06's small-band positive return likely comes from the SUBSET of conditions where the small fills are EARLY in a position that grows large (and wins). Q11 counts ALL small fills individually — many of which never get layered into.

**For copy-trade design, Q11 is the right answer**: the gate sees one fill at a time; we should mirror only fills where the conviction signal (cost_after >= $545) has kicked in.

## Implication for the config

**`sizing_min_target_usdc = 545`** is supported by Q11 (winner rate jumps from 47% to 54% at this boundary) — independent confirmation of Q06's directional finding.

**`sizing_max_target_usdc = 5000`** is supported by Q11 (winner rate drops from 53% to 47% above this) — the algorithm should stop scaling our size above this.

Confidence in these specific thresholds: **75%** (up from 60% on Q06 alone). The cross-validation is the strongest evidence we have so far.
