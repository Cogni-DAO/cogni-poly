---
id: poly.research.queries.q13-current-pXX-primary-vs-hedge.results
type: research
title: "Results history — q13-current-pXX-primary-vs-hedge"
summary: "Run-by-run results for query q13-current-pXX-primary-vs-hedge — tracks numeric drift over time as outcome fan-out progresses."
read_when: "Reviewing how a specific query's output has evolved; before locking config thresholds."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Q13 results — past 14 days (PROD)

Run 1 — 2026-05-16 ~23:25 UTC:

| Wallet    | Role        | Token positions |      p50 |        p75 |        p90 |         p95 |         p99 |
| --------- | ----------- | --------------: | -------: | ---------: | ---------: | ----------: | ----------: |
| RN1       | **primary** |           4,430 | **$966** | **$3,348** | **$8,966** | **$14,615** | **$30,917** |
| RN1       | hedge       |           4,430 |     $130 |       $922 |     $3,761 |      $6,996 |     $17,862 |
| RN1       | single      |           1,458 |      $17 |       $108 |       $560 |      $1,065 |      $2,022 |
| swisstony | **primary** |           7,344 | **$498** | **$1,770** | **$5,372** | **$10,593** | **$28,471** |
| swisstony | hedge       |           7,344 |      $60 |       $341 |     $1,326 |      $2,713 |     $10,370 |
| swisstony | single      |           3,020 |      $46 |       $124 |       $493 |        $999 |      $2,506 |

## Compared to hardcoded `copy-trade-mirror.job.ts` (snapshot 2026-05-03)

| Wallet    | Metric | Hardcoded (mixed) | Primary NOW |           Ratio |
| --------- | ------ | ----------------: | ----------: | --------------: |
| RN1       | p75    |            $1,659 |      $3,348 | **2.0× larger** |
| RN1       | p90    |            $4,632 |      $8,966 |            1.9× |
| RN1       | p95    |            $7,811 |     $14,615 |            1.9× |
| RN1       | p99    |           $32,659 |     $30,917 |           ~same |
| swisstony | p75    |              $619 |      $1,770 | **2.9× larger** |
| swisstony | p99    |           $30,809 |     $28,471 |           ~same |

## Why the difference matters

Hardcoded pXX = mixed primary + hedge tokens (all token positions). Primary-only pXX = excludes the smaller hedge tokens.

**The dominance gate (`target_dominant_other_side`, min_target_side_fraction=0.2) already skips minority-side fills.** So the sizing pXX effectively applies only to primary-side decisions. Therefore the pXX should be calibrated to the **primary-only distribution**.

**Current hardcoded values UNDERFILTER** — they let through positions that are actually below primary-p75. Should be raised to primary-only values.

## Algorithm-aligned hardcoded snapshot

```ts
RN1.TOP_TARGET_SIZE_SNAPSHOTS:       { p50: 966, p75: 3348, p90: 8966, p95: 14615, p99: 30917 }
swisstony.TOP_TARGET_SIZE_SNAPSHOTS: { p50: 498, p75: 1770, p90: 5372, p95: 10593, p99: 28471 }
```
