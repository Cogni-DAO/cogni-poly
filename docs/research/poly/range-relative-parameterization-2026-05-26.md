---
id: poly-range-relative-parameterization-2026-05-26
type: research
title: "Parameterization SQL for range-relative position_gap rewrite"
status: draft
trust: draft
summary: "One-shot SQL parameterization (Q1–Q4) against candidate-a's poly DB for the position_gap rewrite proposed in range-relative-mirror-2026-05-26.md. Output: target_range_max_usdc = $10,000 for swisstony and RN1 (p95 of per-condition peak cost-basis); peak concurrent open conditions = 852 / 4,958; 0% true multi-outcome (>2 tokens); ~24% neg-risk parent-event sub-conditions (handled normally as binaries, no skip rule); one acknowledged deviation from NO_SELL_IN_MIRROR (RN1 had a single 36-second strategic SELL burst on 2026-04-01, $27k of $0.30-priced exits)."
read_when: "Locking the deploy values for target_range_max_usdc, mirror_max_alloc_per_condition_usdc, and poly_wallet_grants.total_at_risk_usdc for the new matrix tenants. Updating range-relative-mirror-2026-05-26.md status note. Reviewing the NO_SELL deviation finding before the implementation PR."
owner: derekg1729
created: 2026-05-26
implements: range-relative-mirror-2026-05-26
tags: [poly, copy-trading, parameterization, sql, swisstony, rn1]
---

# Range-Relative Parameterization — 2026-05-26

Source data: `poly_trader_fills` + `poly_trader_position_snapshots` on `candidate-a.vm.cognidao.org:5432` (cogni_poly database), accessed via `scripts/grafana-postgres-query.sh --env candidate-a --node poly`.

Snapshot writer started 2026-05-03 → ~23 days of `poly_trader_position_snapshots` coverage at run time. `poly_trader_fills` is fully backfilled from wallet birth (spike.5024).

## Q1 — SELL audit (deploy gate)

**Goal**: validate `NO_SELL_IN_MIRROR` invariant. The design rests on target traders being long-only / hold-to-redemption.

| Window        |              swisstony BUY | swisstony SELL |   RN1 BUY | RN1 SELL |
| ------------- | -------------------------: | -------------: | --------: | -------: |
| 0–7d          |                    141,870 |          **0** |    95,476 |    **0** |
| 0–30d         |                    299,699 |          **0** |   252,413 |    **1** |
| 30–45d        |                    277,419 |          **0** | (not run) |        — |
| 45–60d        |                    279,908 |          **0** | (not run) |        — |
| 60–90d        |                    834,977 |          **0** | (not run) |        — |
| **Total 90d** | **1,693,873 BUY / 0 SELL** |                |           |          |

**swisstony**: pure long-only. 1.69M BUYs across 90 days, zero SELLs. `NO_SELL_IN_MIRROR` holds unconditionally.

**RN1**: not strictly long-only. 60-day SELL detail:

| Date           |     n | Prices    | Interpretation                                                                                                                   |
| -------------- | ----: | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-13     |     1 | $0.999    | At-payout exit (functional redemption)                                                                                           |
| 2026-04-13     |     6 | $0.999    | At-payout exits (functional redemptions)                                                                                         |
| **2026-04-01** | **3** | **$0.30** | **Strategic exit** — same condition `0xf01f219b…`, same token `2368759848…`, 36 seconds apart, 90,000 shares / **$27,000 total** |

The April 1 burst is a real strategic position exit, NOT a redemption-equivalent. RN1 dumped a 90k-share position into a $0.30 market over 36 seconds.

### Deploy-gate verdict — accepts with documented exception

`NO_SELL_IN_MIRROR` is upheld for v0 with this acknowledged deviation:

- **swisstony**: invariant holds. No code change needed.
- **RN1**: invariant holds in expectation (>99.99% of fills) but the rare strategic exit will leave us over-allocated vs RN1's reduced position. The design handles this gracefully — when RN1's `target_position_usdc` drops, `delta` drops, `desired_usdc` drops, gap goes negative, planner skips `followup_not_needed`, we hold our existing position to whatever the market resolves at. We never sell to follow. The cost is bounded by `mirror_max_alloc_per_condition_usdc` per affected condition.

**Not blocking**. Design proceeds. Cost is documented; not a forcing function for SELL infrastructure in this PR.

## Q2 — `target_range_max_usdc` parameterization

**Goal**: pick a per-target ceiling that 95% of conditions stay under, so the breach-alert volume is operator-tolerable.

Per-condition peak cost-basis (sum across tokens on the condition, max over `captured_at`) from `poly_trader_position_snapshots`:

| Wallet    | Conditions |  p50 |    p75 |    p90 |     **p95** |     p99 |      Max |
| --------- | ---------: | ---: | -----: | -----: | ----------: | ------: | -------: |
| swisstony |      9,957 | $477 | $1,942 | $6,019 | **$10,069** | $24,031 | $427,364 |
| RN1       |      9,871 | $180 | $1,197 | $4,630 |  **$9,142** | $28,295 | $172,318 |

### Important correction to the design doc's example

The design's worked example used `target_range_max_usdc = $500k`. **That's off by ~50×.** Real-world p95 is ~$10k. The distribution is heavily skewed: most positions are tiny ($477 median), but rare ones reach $400k+. Treating $500k as "typical max" would scale `relative` so low that virtually nothing ever places.

### Locked deploy values

| Target    | `target_range_max_usdc` | Rationale                                                         |
| --------- | ----------------------: | ----------------------------------------------------------------- |
| swisstony |             **$10,000** | p95 rounded; ~5% of conditions trigger `poly.mirror.range_breach` |
| RN1       |             **$10,000** | p95 rounded; same scale; uniform value simplifies operator config |

Operator may PATCH upward per condition class when alerts fire on conditions worth scaling into.

## Q3 — Peak concurrent open conditions (grant sizing input)

**Goal**: size `poly_wallet_grants.total_at_risk_usdc` for new matrix tenants per C1 formula: `mirror_max_alloc_per_condition_usdc × peak_concurrent × 2`.

Peak concurrent open conditions (`COUNT(DISTINCT condition_id WHERE shares > 0) over time`) from `poly_trader_position_snapshots`:

| Wallet    | Peak concurrent | Avg concurrent | Min concurrent |
| --------- | --------------: | -------------: | -------------: |
| swisstony |         **852** |             71 |              1 |
| RN1       |           4,958 |             29 |              1 |

### Caveat

RN1's `peak_concurrent = 4,958` (50% of lifetime conditions) is anomalous. Most likely cause: the spike.5024 backfill (2026-05-05) loaded historical fills, and `poly_trader_position_snapshots` captured many tiny / dust-residual positions as "open" before resolution caught up. This is a snapshot-artifact, not a real "RN1 holds 5k concurrent positions" reality. For grant sizing, recommend treating this with skepticism and using the operationally-sensible `avg_concurrent × 5 = 145` as the working number for RN1 unless investigation refines this.

### Locked grant-sizing values

For the new matrix tenants at three `mirror_max_alloc_per_condition_usdc` tiers ($5 / $20 / $200), per C1 formula (`max_alloc × peak_concurrent × 2` for swisstony, who is the focus target):

| Tier   | max_alloc | peak_concurrent (swisstony) | total_at_risk_usdc |
| ------ | --------: | --------------------------: | -----------------: |
| Small  |        $5 |                         852 |         **$8,520** |
| Medium |       $20 |                         852 |        **$34,080** |
| Large  |      $200 |                         852 |       **$340,800** |

`daily_cap_usdc` sizing: estimate ~50 new conditions/day × max_alloc × 2 → $500 / $2,000 / $20,000.

These are paper-trading tenants — actual USDC at risk is zero — but the grant cap is what the planner respects, so it must be sized realistically or the soak will hit the cap and stop placing.

## Q4 — True multi-outcome + neg-risk prevalence (informational)

> **Correction (rev 2).** First run of Q4 measured `COUNT(DISTINCT token_id) per condition_id` and reported "0% multi-outcome" as "0% neg-risk." That conflation is wrong. **Neg-risk is not the same as multi-outcome >2 tokens** — neg-risk is a per-market boolean (`attributes.negativeRisk = true` in Gamma) flagging that the market is one of several binary sub-conditions belonging to a parent event group (e.g. each candidate in an election is its own conditionId with YES/NO tokens, all flagged `negativeRisk: true`, with adapter-level netting at resolution). Q4 now reports both numbers separately.

### Q4a — True multi-outcome (>2 tokens per conditionId)

Per-condition distinct token count from `poly_trader_position_snapshots`:

| Wallet    | Total conditions | Binary (≤2 tokens) | True multi-outcome (>2) | True multi-outcome % |
| --------- | ---------------: | -----------------: | ----------------------: | -------------------: |
| swisstony |            9,957 |              9,957 |                       0 |            **0.00%** |
| RN1       |            9,871 |              9,871 |                       0 |            **0.00%** |

Both targets exclusively trade conditions with ≤2 tokens. True multi-outcome (one conditionId, N≥3 tokens) is absent from their activity.

### Q4b — Neg-risk prevalence (per-market `negativeRisk` flag)

Joined `poly_trader_position_snapshots → poly_market_metadata` and checked `raw->>'negativeRisk'`:

| Wallet    | Total conditions | Neg-risk | Non-neg-risk | Missing metadata | **Neg-risk %** |
| --------- | ---------------: | -------: | -----------: | ---------------: | -------------: |
| swisstony |            9,965 |    2,384 |        7,581 |                0 |      **23.9%** |
| RN1       |            9,876 |    2,520 |        7,356 |                0 |      **25.5%** |

Nearly 1-in-4 of each target's conditions are neg-risk sub-conditions. This is the common case, not an edge case.

### Verdict

**Neither number gates the design** — the planner math (per-condition-sum scale, per-token vwap conversion, per-token gap) handles binary, true multi-outcome, and neg-risk sub-conditions identically and correctly. There is no skip rule for any of these in the final design (the multi-outcome skip proposed in early drafts was dropped in design doc revision 4).

Q4 stays as informational context only. The key risk it averted: had a "skip neg-risk" rule shipped (which the earlier `poly.mirror.neg_risk_skipped` naming would have invited), ~24% of swisstony's alpha-bearing activity would have been silently dropped.

## Summary — locked values for the implementation PR

| Knob                                                           | Value                                                          | Source          |
| -------------------------------------------------------------- | -------------------------------------------------------------- | --------------- |
| `target_range_max_usdc` (swisstony)                            | $10,000                                                        | Q2 p95          |
| `target_range_max_usdc` (RN1)                                  | $10,000                                                        | Q2 p95          |
| `mirror_max_alloc_per_condition_usdc` tiers                    | $5 / $20 / $200                                                | Design doc C4   |
| `poly_wallet_grants.total_at_risk_usdc` (per tier × swisstony) | $8,520 / $34,080 / $340,800                                    | Q3 + C1 formula |
| `NO_SELL_IN_MIRROR` invariant                                  | Upheld with documented RN1 deviation                           | Q1              |
| Per-condition-sum handles binary + multi-outcome + neg-risk    | Confirmed: 0% true multi-outcome, ~24% neg-risk (no skip rule) | Q4              |
