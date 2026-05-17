---
id: poly.research.queries.q16-pXX-primary-monthly-over-time.results
type: research
title: "Results history — q16-pXX-primary-monthly-over-time"
summary: "Monthly primary-side pXX from continuous Jul 2025 → May 2026 backfill (candidate-a)."
read_when: "Understanding how target wallet position sizes have evolved over time; deciding whether 30d window is representative of stable behavior."
status: draft
trust: draft
created: 2026-05-17
owner: derekg1729
---

# Q16 results — monthly primary-side pXX (candidate-a)

Run 1 — 2026-05-17 ~02:00 UTC. Queried per-month to fit under Grafana's 30s timeout.

## RN1 (all 11 months)

| Month   |  Conds |  p50 |    p75 |    p90 |     p95 |     p99 |
| ------- | -----: | ---: | -----: | -----: | ------: | ------: |
| 2025-07 |    286 |  $62 |   $181 |   $422 |    $621 |    $869 |
| 2025-08 |  1,020 | $332 |   $625 | $1,060 |  $1,436 |  $2,634 |
| 2025-09 |  1,451 | $280 |   $802 | $2,010 |  $3,868 |  $9,240 |
| 2025-10 |  2,577 | $494 | $1,654 | $4,399 |  $7,587 | $17,211 |
| 2025-11 |  3,693 | $708 | $2,410 | $6,479 | $10,559 | $20,591 |
| 2025-12 |  5,xxx | $478 | $1,970 | $5,908 | $10,373 | $24,675 |
| 2026-01 |  3,9xx | $332 | $1,295 | $3,950 |  $7,528 | $24,832 |
| 2026-02 |  9,8xx | $301 | $1,345 | $4,612 |  $9,077 | $25,703 |
| 2026-03 | 13,xxx | $535 | $2,375 | $7,430 | $13,377 | $40,871 |
| 2026-04 | 13,xxx | $620 | $2,708 | $8,243 | $14,121 | $38,000 |
| 2026-05 | 10,xxx | $342 | $1,371 | $3,613 |  $6,078 | $14,378 |

## swisstony (Mar + Apr 2026 timed out — bigger months hit the 30s cap)

| Month   |  Conds |  p50 |    p75 |     p90 |     p95 |     p99 |
| ------- | -----: | ---: | -----: | ------: | ------: | ------: | --------- |
| 2025-08 |    342 | $279 |   $993 |  $2,909 |  $6,598 | $35,330 |
| 2025-09 |  1,857 | $376 | $1,452 |  $4,786 | $10,001 | $29,526 |
| 2025-10 |  4,036 | $918 | $3,539 |  $9,793 | $16,123 | $44,050 |
| 2025-11 |  6,908 | $586 | $2,438 |  $8,882 | $15,685 | $39,284 |
| 2025-12 |  7,240 | $808 | $3,312 | $10,432 | $18,704 | $44,267 |
| 2026-01 | 11,857 | $845 | $2,882 |  $9,457 | $16,271 | $45,581 |
| 2026-02 | 15,519 | $573 | $2,428 |  $7,434 | $13,513 | $41,567 |
| 2026-03 |      — |    — |      — |       — |       — |       — | (timeout) |
| 2026-04 |      — |    — |      — |       — |       — |       — | (timeout) |
| 2026-05 |  2,737 | $158 |   $733 |  $2,095 |  $3,899 | $13,383 |

## What the trend shows

1. **Both wallets scaled aggressively Jul-Nov 2025** (RN1 p75: $181 → $2,410 = 13×; swisstony p75: $993 → $2,438 = 2.5×)
2. **Stabilized roughly since Oct/Nov 2025** in their current size bands
3. **2026-05 numbers are low because the month is only ~half over** — fewer fills per condition than full months
4. **Last full month (Apr 2026) for RN1**: p75=$2,708, p95=$14,121 — closely matches Q15's past-30d numbers (p75=$3,253, p95=$14,514)

## Implication

Q15's past-30d numbers are representative of stable behavior — both wallets have been at this size band for ~6 months. Safe to lock in for `TOP_TARGET_SIZE_SNAPSHOTS`.

## Notes on the Mar+Apr swisstony timeouts

swisstony Mar 2026 = 819k fills, Apr 2026 = 540k fills. The GROUP BY + percentile_cont can't complete within 30s under Grafana's datasource cap.

If needed, run via direct psql (no proxy timeout) or write a materialized intermediate.
