---
id: poly.research.queries.q06-rn1-realized-pnl-by-cost-band.results
type: research
title: "Results history — q06-rn1-realized-pnl-by-cost-band"
summary: "Run-by-run results for query q06-rn1-realized-pnl-by-cost-band — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q06 results history

| Run | Time UTC | Resolved | ≤$100 % | $100-545 % | $545-1229 % | $1229-5k % | >$5k % |
| --- | -------- | -------: | ------: | ---------: | ----------: | ---------: | -----: |
| 1   | 21:00    |      527 |   +2.4% |      -0.8% |       +4.7% | **+10.4%** |  -3.7% |
| 2   | 22:30    |      663 |  +4.16% |     +5.63% |      +1.77% | **+9.26%** | -0.90% |
| 3   | 22:55    |      732 |  +5.97% |     +5.12% |      +7.63% | **+8.88%** | +0.17% |

## What's stable / unstable

**Stable across all runs**:

- `$1,229-$5,000` is the PEAK band (+10.4% → +9.26% → +8.88%, declining but always #1)
- `>$5,000` band has near-zero / slightly-negative return (decline from -3.7% → +0.17%)

**Unstable**:

- All small bands (≤$100, $100-$545) flipped signs between runs as more outcomes resolved

**SAMPLE WARNING**: 732 / 8,914 = 8.2% resolved coverage on RN1 conds. Low confidence on any single-band claim until coverage exceeds 30%.

## Cross-validation with Q11

Q11 buckets fills by `cost_after` (algorithm view), not by condition's total_cost. **Q11 is more reliable for config-tuning** because it matches what `bet-sizer-v1` sees. See [q11 results](./q11-rn1-realized-pnl-by-fill-cost-after.results.md).

Q11 + Q06 agree on the **profit-band threshold** at $545-$5,000 even though Q06's per-band % returns are unstable. The directional finding is robust; the magnitudes are not.

## What I can claim with reasonable confidence (60-75%)

- **`sizing_min_target_usdc = 545` is justified** by Q11's win-rate gradient (47% → 54%) at this boundary.
- **`sizing_max_target_usdc = 5000` is justified** by Q11's win-rate drop (53% → 47%) above this.
- **Specific per-band P/L magnitudes are NOT load-bearing** — they shift run-to-run.

## ACTION required before locking config

Re-run Q06 + Q11 daily as outcome fan-out progresses. Lock thresholds only when 30%+ coverage is reached. Until then, treat the recommendation as "best current guess" not "validated truth".
