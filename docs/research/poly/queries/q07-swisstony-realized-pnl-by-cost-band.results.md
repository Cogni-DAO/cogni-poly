---
id: poly.research.queries.q07-swisstony-realized-pnl-by-cost-band.results
type: research
title: "Results history — q07-swisstony-realized-pnl-by-cost-band"
summary: "Run-by-run results for query q07-swisstony-realized-pnl-by-cost-band — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q07 results history

| Run | Time                  |       ≤$100 | $100-545 | $545-1229 | $1229-5k |        >$5k |
| --- | --------------------- | ----------: | -------: | --------: | -------: | ----------: |
| 1   | 2026-05-16 ~21:30 UTC |      +17.0% |    +0.8% |     -3.4% |    +3.4% |      +14.2% |
| 2   | 2026-05-16 ~22:30 UTC | **+11.36%** |   -0.04% |    +1.67% |   +4.73% | **+13.03%** |

**STABLE CLAIMS** (between runs):

- ≤$100 band positive (>+10%) — likely real
- > $5,000 band positive (+13-14%) — likely real
- Middle bands ($100-$1,229) weak or zero

**Barbell profile is robust**. swisstony's edge lives at the size extremes, not the middle. Confidence: 70-75%.

**ACTION:** Lock in swisstony config that targets ≤$100 (small budget) + >$5k (big budget). Skip the middle.
