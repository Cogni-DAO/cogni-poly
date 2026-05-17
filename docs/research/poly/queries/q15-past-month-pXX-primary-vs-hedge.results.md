---
id: poly.research.queries.q15-past-month-pXX-primary-vs-hedge.results
type: research
title: "Results history — q15-past-month-pXX-primary-vs-hedge"
summary: "Past-30-day primary/hedge/single token-position pXX (PROD). The numbers to use in TOP_TARGET_SIZE_SNAPSHOTS."
read_when: "Calibrating sizing_min_target_usdc / sizing_max_target_usdc / TOP_TARGET_SIZE_SNAPSHOTS hardcoded values."
status: draft
trust: draft
created: 2026-05-17
owner: derekg1729
---

# Q15 results — past 30 days, PROD

Run 1 — 2026-05-17 ~02:00 UTC:

## RN1

| Role    | Token positions |      p50 |        p75 |        p90 |         p95 |         p99 |      Max |
| ------- | --------------: | -------: | ---------: | ---------: | ----------: | ----------: | -------: |
| primary |           4,486 | **$955** | **$3,253** | **$8,855** | **$14,514** | **$30,901** | $113,195 |
| hedge   |           4,486 |     $128 |       $901 |     $3,707 |      $6,972 |     $17,827 |  $67,065 |
| single  |           1,462 |      $17 |       $110 |       $557 |      $1,042 |      $1,993 |  $20,164 |

## swisstony

| Role    | Token positions |      p50 |        p75 |        p90 |         p95 |         p99 |      Max |
| ------- | --------------: | -------: | ---------: | ---------: | ----------: | ----------: | -------: |
| primary |           7,414 | **$498** | **$1,767** | **$5,290** | **$10,576** | **$28,413** | $253,809 |
| hedge   |           7,414 |      $61 |       $341 |     $1,330 |      $2,694 |     $10,357 |  $41,443 |
| single  |           3,067 |      $47 |       $128 |       $504 |        $999 |      $2,515 |  $35,763 |

## Compare to currently-hardcoded `copy-trade-mirror.job.ts` (snapshot 2026-05-03)

The hardcoded values were computed over **all** token positions (including hedges), which deflates the low-end percentiles ~2-3×.

| Wallet    | Metric | Hardcoded (mixed) | Primary 30d | Ratio |
| --------- | ------ | ----------------: | ----------: | ----: |
| RN1       | p75    |            $1,659 |      $3,253 |  2.0× |
| RN1       | p90    |            $4,632 |      $8,855 |  1.9× |
| RN1       | p95    |            $7,811 |     $14,514 |  1.9× |
| RN1       | p99    |           $32,659 |     $30,901 | ~same |
| swisstony | p75    |              $619 |      $1,767 |  2.9× |
| swisstony | p99    |           $30,809 |     $28,413 | ~same |

The dominance gate (`target_dominant_other_side`) already skips minority-side fills,
so sizing pXX should be calibrated to the **primary-only** distribution.

## Stability vs Q13 (past 14d, same shape)

| Metric          | Q13 14d | Q15 30d |
| --------------- | ------: | ------: |
| RN1 primary p75 |  $3,348 |  $3,253 |
| RN1 primary p95 | $14,615 | $14,514 |
| swisstony p75   |  $1,770 |  $1,767 |
| swisstony p95   | $10,593 | $10,576 |

**Numbers are stable to within 1%** between 14-day and 30-day windows → these are robust thresholds.
