---
id: poly.research.queries.q08-rn1-win-rate-by-cost-band.results
type: research
title: "Results history — q08-rn1-win-rate-by-cost-band"
summary: "Run-by-run results for query q08-rn1-win-rate-by-cost-band — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q08 results history

| Run | Time                  | ≤$100 win% | $100-545 | $545-1229 | $1229-5k |  >$5k |
| --- | --------------------- | ---------: | -------: | --------: | -------: | ----: |
| 1   | 2026-05-16 ~21:30 UTC |      64.2% |    94.2% |     96.4% |     100% | 98.6% |
| 2   | 2026-05-16 ~22:30 UTC |      65.4% |    94.7% |     95.0% |     100% | 98.8% |

**Win-rate gradient is STABLE across runs** (changes < 1.5pp per band).

## ⚠️ Interpretation pitfall

"Win rate" by this query = `count(conds where ANY winning_shares > 0) / count(conds)`. For RN1's paired-token positions, this is almost always true since one token always wins. So this metric mostly reflects **what fraction of positions are paired**, not conviction.

The smaller cost bands (≤$100) include single-side / under-built positions where the wallet only had fills on the losing side — those count as "no winning shares". That's why the small band drops to 65%.

The 100% win rate at $1,229-$5k means **all 137 positions in this band are paired**, not that RN1 picks winners 100% of the time. **One of the two tokens always wins** — that's mechanical, not skill.

## What's the REAL edge signal?

**Q06 (realized P/L %)** is the right edge signal. Win-rate-by-paired-count is descriptive only.

Q06's $1,229-$5k band shows +9.26% return on $351k cost — that's the asymmetric-sizing edge (target's primary > loser hedge), which IS skill. But Q06 is the metric that's unstable across runs (see Q06 results history).

## Prior claim correction

I previously wrote "**RN1's bet size IS their conviction signal**" because of the win-rate gradient. That was wrong. The win-rate gradient is mostly a pairing-completeness signal; the conviction signal is the asymmetric Q06 P/L gradient, and that's a less clean monotonic pattern.
