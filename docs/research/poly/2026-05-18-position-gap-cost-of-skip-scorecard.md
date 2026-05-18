---
id: position-gap-cost-of-skip-2026-05-18
type: research
title: "position_gap cost-of-skip scorecard — 24h candidate-a (corrected v2)"
status: draft
domain: poly_position_gap
entry_type: scorecard
confidence_pct: 65
trust: draft
summary: "24h Postgres + Loki sweep of candidate-a tenants under chr.poly-algo-tenant-matrix. position_gap is currently live on the WRONG TARGET — cand-a/RN1-GAP (RN1) — not on swisstony where the charter says the A/B belongs. cand-a/RN1-GAP placed 7 paper orders / 3,233 decisions (0.2%); the same-target control cand-a/VALIDATION placed 138 / 9,290 (1.5%). Apples-to-apples requires PATCHing cand-a/GAP (swisstony slot) onto position_gap — no code change. Earlier v1 of this doc mis-attributed the data to swisstony and claimed zero placements; both wrong."
read_when: Deciding the next position_gap move. Sizing the Phase 2 A/B done-condition. Reviewing the v1 scorecard claim about target_scale calibration (revised).
owner: derekg1729
created: 2026-05-18
updated: 2026-05-18
tags:
  [poly, copy-trading, position-gap, scorecard, tenant-matrix, charter-aligned]
---

# position_gap cost-of-skip scorecard (v2, corrected)

> **What this doc is.** A snapshot of where `position_gap` (D2 Phase 2, PR #92) stands 24h after merge, framed against [`chr.poly-algo-tenant-matrix`](../../../work/charters/POLY_ALGO_TENANT_MATRIX.md). Narrative + math walkthrough is in [`position-gap-explainer.html`](./position-gap-explainer.html). This file is the data.

## Tenant landscape (candidate-a, 24h)

Source: charter audit query (`scripts/grafana-postgres-query.sh --env candidate-a --node poly`), joined with `poly_copy_trade_targets` for policy/target lookup. Tenant names per `.env.cogni` env-key roles.

| TENANT NAME           | id-short   | target    | policy        |  p% | $ cap | decisions/24h | placed/24h | place-rate |
| --------------------- | ---------- | --------- | ------------- | --: | ----: | ------------: | ---------: | ---------: |
| cand-a/orphan-1       | `20fdb57a` | swisstony | auto (TPS)    |  75 |    $5 |        25,828 |        888 |       3.4% |
| cand-a/orphan-2       | `809e37f7` | swisstony | auto (TPS)    |  75 |    $5 |        24,988 |        883 |       3.5% |
| cand-a/orphan-3       | `acd63233` | swisstony | auto (TPS)    |  75 |    $5 |        24,976 |        883 |       3.5% |
| **cand-a/VALIDATION** | `1890787d` | swisstony | auto (TPS)    |  80 |   $15 |         9,290 |        138 |       1.5% |
| **cand-a/GAP**        | `d66032aa` | swisstony | auto (TPS) ⚠ |  75 |    $5 |         7,999 |        106 |       1.3% |
| **cand-a/RN1-GAP**    | `f472b6ad` | **RN1**   | position_gap  |  80 |   $15 |         3,233 |    7 paper |       0.2% |

⚠ `cand-a/GAP` is the **slot** for swisstony+position_gap per charter, currently still on `auto`. Pending PATCH per charter open item.

**Headline.** Only one position_gap row exists on candidate-a today — and it's on RN1, not swisstony. The charter is explicit that swisstony is the right A/B substrate (volume, position-size distribution). The swisstony+position_gap slot (`cand-a/GAP`) is pre-allocated and just needs a PATCH.

## Position_gap detail (cand-a/RN1-GAP only)

Source: Loki sweep `event="poly.mirror.decision" |~ "position_gap"` over 24h. ~1,394 of the 3,233 DB decisions are in the Loki window (retention).

| Skip reason                      | Count | Σ skipped $ | Avg/skip | Max/skip | Algorithmic gap?                                                                 |
| -------------------------------- | ----: | ----------: | -------: | -------: | -------------------------------------------------------------------------------- |
| `market_past_end_date`           |   415 |     $122.35 |    $0.29 |    $1.86 | ⚪ correct skip (market resolved)                                                |
| `vwap_floor_breach`              |   285 |      $53.27 |    $0.19 |    $0.75 | 🟡 gate semantic (see explainer §6)                                              |
| `below_market_min`               |   374 |      $32.91 |    $0.09 |    $0.33 | 🟡 binding on RN1 distribution; unknown on swisstony until cand-a/GAP is patched |
| `target_dominant_other_side`     |   319 |       $3.14 |    $0.01 |    $0.06 | ⚪ minority correctly skipped under position_gap design                          |
| `price_outside_clob_bounds`      |     1 |       $0.01 |    $0.01 |    $0.01 | ⚪ tick-grid rejection                                                           |
| PLACED (paper, all `mode_paper`) |     7 |           — |        — |        — | placements running through paper sidecar (mode-column anti-pattern per charter)  |

## Pareto move (revised)

**PATCH `cand-a/GAP` (the swisstony slot) to `sizing_policy_kind=position_gap`. No PR.**

```bash
source .env.cogni
curl -X PATCH "https://poly-test.cognidao.org/api/v1/poly/copy-trade/targets/$POLY_CANDIDATE_A_TENANT_GAP_TARGET_ID" \
  -H "Authorization: Bearer $POLY_CANDIDATE_A_TENANT_GAP_API_KEY" \
  -H "content-type: application/json" \
  -d '{"sizing_policy_kind":"position_gap","mirror_filter_percentile":80,"mirror_max_usdc_per_trade":15.00}'
```

Then wait 24h and re-run the audit. Same-target apples-to-apples vs `cand-a/VALIDATION` (the swisstony+TPS p80/$15 control). That's the cell the charter asks for and the D2 Phase 2 done-condition demands.

**Predicted outcome at 24h post-PATCH** (cand-a/GAP, swisstony, p80/$15, position_gap with bootstrap `target_scale = 1e-4`):

| Metric                             | cand-a/VALIDATION (control) | cand-a/GAP (predicted) | Note                                                                                                  |
| ---------------------------------- | --------------------------: | ---------------------: | ----------------------------------------------------------------------------------------------------- |
| decisions / 24h                    |                       9,290 |                 ~9,000 | same fill stream                                                                                      |
| placed / 24h                       |                         138 |                 ~30–80 | position-driven, smaller per fill, swisstony p50 cost ~$1-2k → desired ~$0.10-0.40 → many below floor |
| minority-side placements           |                 significant |                     ~0 | by design — gap collapses below floor                                                                 |
| Ruud-style inverted-weighting risk |                        HIGH |                   ZERO | structural                                                                                            |

Confidence: **~65%.** The "~30-80 placed" prediction is uncertain — depends on swisstony's actual per-token-cost distribution which I haven't measured directly. The structural minority-side suppression is high confidence.

## What v1 of this doc got wrong

| Claim in v1                                                 | Reality                                                                                                                       | Why I missed it                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "swisstony target on candidate-a"                           | RN1, not swisstony. cand-a/RN1-GAP mirrors `0x2005…75ea` (RN1), not `0x204f…5e14` (swisstony).                                | Filtered Loki by `sizing_policy_kind=position_gap` — correctly returns only `cand-a/RN1-GAP` — but I never checked the target_wallet field on the decisions. Charter would have told me. |
| "ZERO placements in 24h"                                    | 7 placements (`reason: mode_paper` — paper sidecar). DB ground-truth via charter audit query.                                 | Loki query window cut off before the placements happened. DB confirms within 24h. Conflated "no log line yet" with "didn't happen."                                                      |
| "Pareto move is calibrate `target_scale` per-target column" | Pareto move is PATCH `cand-a/GAP` to position_gap. The calibration argument was built on RN1's distribution, not swisstony's. | Anchored on the wrong target's distribution. Swisstony positions are larger (charter p95 ~$7k) so the 50× under-calibration claim doesn't hold the same way.                             |

**Lesson for future loops:** the charter's audit query is the right entry point. Loki alone is selective by retention + label filter; joining the ledger against `poly_copy_trade_targets` in Postgres is the only way to see _which tenant_ is producing each decision class.

## Pointers

- Explainer: [`position-gap-explainer.html`](./position-gap-explainer.html) — §6 (VWAP first-class gap) · §9 (this scorecard rendered) · §10 (policy-knob mapping legacy UI → position_gap)
- Charter: [`chr.poly-algo-tenant-matrix`](../../../work/charters/POLY_ALGO_TENANT_MATRIX.md) — tenant table + audit query + open items (mode-column anti-pattern, consolidation policy)
- Spec: [`docs/spec/poly-copy-trade-position-mirror.md`](../../spec/poly-copy-trade-position-mirror.md) §"Intelligent-monitoring gaps" — the F-severity catalog this scorecard tests against
- PR #92 (task.5001) — wire integration that this scorecard measures
- PR #95 (task.5002) — spec gap catalog (Phase 2 → Phase 5 punch list)
- PR #94 — floor-clamp leak fix (separate dev, B2 from the original review)

#poly #copy-trading #position-gap #scorecard #tenant-matrix
