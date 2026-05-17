---
id: poly.research.queries.q02-rn1-lifetime-pnl.results
type: research
title: "Results history — q02-rn1-lifetime-pnl"
summary: "Run-by-run results for query q02-rn1-lifetime-pnl — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q02 results history

| Run | Time                  | RN1 latest_pnl (1d) | swisstony latest_pnl (1d) |
| --- | --------------------- | ------------------: | ------------------------: |
| 1   | 2026-05-16 ~19:00 UTC |          $8,999,706 |                $8,112,838 |
| 2   | 2026-05-16 ~22:45 UTC |          $8,999,751 |                $8,178,643 |

**Stable across runs** (~$45 drift on RN1, +$66k on swisstony — both growing as expected).

**High confidence (98%)** that:

- RN1 has earned approximately **$9.0M** since 2025-07-09
- swisstony has earned approximately **$8.18M** since 2025-08-10
- Both wallets are still actively profitable (PnL growing in real-time)

**This is Polymarket's own user-pnl-api number** — their ground truth via their API. Not derived. Highest-confidence number in this whole investigation.
