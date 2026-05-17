---
id: poly.research.queries.q03-rn1-buy-vs-sell.results
type: research
title: "Results history — q03-rn1-buy-vs-sell"
summary: "Run-by-run results for query q03-rn1-buy-vs-sell — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q03 results history

| Run | Time                  | swisstony BUY | swisstony SELL | RN1 BUY |                       RN1 SELL |
| --- | --------------------- | ------------: | -------------: | ------: | -----------------------------: |
| 1   | 2026-05-16 ~18:00 UTC |       129,267 |              0 | 117,114 |                              1 |
| 2   | 2026-05-16 ~22:45 UTC |       130,895 |              0 | 116,776 | **0** (one aged out of window) |

**Both runs confirm**: SELL fills are essentially absent. The 1 stale SELL in run 1 aged out of the 7-day rolling window.

**Strategy implication (HIGH CONFIDENCE — 99%)**: both wallets exit exclusively via:

- Market resolution (CTF `redeemPositions` at $1/share for winning tokens)
- Neg-risk converter (for multi-outcome events)

**Never** via active sell into the CLOB book.

For copy-trade design: we should expect to hold positions to resolution. Mirror logic does NOT need sell-side handling.
