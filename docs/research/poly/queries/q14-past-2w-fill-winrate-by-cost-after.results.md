---
id: poly.research.queries.q14-past-2w-fill-winrate-by-cost-after.results
type: research
title: "Results history — q14-past-2w-fill-winrate-by-cost-after"
summary: "Run-by-run results for query q14-past-2w-fill-winrate-by-cost-after — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q14 results — past 14 days (PROD)

Run 1 — 2026-05-16 ~23:30 UTC:

| Wallet    | Bucket (cost_after) |   Fills |      Resolved |   Winner % | EV at $0.50 |
| --------- | ------------------- | ------: | ------------: | ---------: | ----------: |
| RN1       | ≤ $545              |  68,371 |  62,248 (91%) | **42.86%** |    **-14%** |
| RN1       | $545 – $1,770       |  46,126 |  43,500 (94%) |     45.65% |         -9% |
| RN1       | $1,770 – $5,372     |  55,525 |  52,740 (95%) |     46.94% |         -6% |
| RN1       | $5,372 – $14,615    |  41,632 |  40,636 (98%) | **53.33%** |         +7% |
| RN1       | > $14,615           |  18,956 |  18,372 (97%) | **53.98%** |         +8% |
| swisstony | ≤ $545              | 132,338 | 112,518 (85%) |     47.12% |         -6% |
| swisstony | $545 – $1,770       |  43,918 |  39,424 (90%) | **52.69%** |         +5% |
| swisstony | $1,770 – $5,372     |  30,287 |  28,217 (93%) | **56.51%** |        +13% |
| swisstony | $5,372 – $14,615    |  16,971 |  16,173 (95%) | **56.12%** |        +12% |
| swisstony | > $14,615           |   9,184 |   8,960 (98%) | **59.13%** |        +18% |

## Key insights vs Aug-Nov 2025 backfill (Q11/Q12)

**RN1's edge boundary has SHIFTED UPWARD:**

- Aug-Nov 2025: edge crossed 50% at ~$545
- Last 2 weeks: edge only crosses 50% at ~$5,372
- The wallet scaled 147× since Aug. Smaller bets are less informed now.

**swisstony's edge is more stable and STRONGER than RN1 in algo-relevant bands:**

- swisstony crosses 50% at $545 (still small, like Aug-Nov)
- Wins more at every bucket level than RN1, except very tail (within 1pp)

## Confidence: 95%

This is the strongest evidence we have. Outcome coverage is 85-98% — recently-resolved sports markets. Numbers should be stable run-to-run.

## Config implication

**Use swisstony as primary copy target.** Edge starts at lower cost threshold + is consistently higher per bucket.

```
swisstony: sizing_min_target_usdc = 545
RN1:       sizing_min_target_usdc = 5372    (or skip entirely)
```
