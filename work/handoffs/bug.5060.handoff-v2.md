---
id: bug.5060.handoff-v2
type: handoff
title: "paper-trader engine is NOT the bug — preview-specific planner/sizing divergence"
work_item: bug.5060
project: proj.poly-paper-trading
created: 2026-05-18
supersedes: work/handoffs/bug.5060.handoff.md
author: claude (brisbane-v2 session, ~2h investigation)
severity: critical
status_for_next_agent: needs_implement (root cause corrected)
---

# bug.5060 — handoff v2

## TL;DR

**The original handoff hypothesis (pm_trader engine BBO-only queue bug) is WRONG.** The same pm_trader engine fills at 53% on candidate-a (parity with prod live's 57%) but at 4% on preview. **The bug is preview-specific** — almost certainly the new sizing-policy planner code (PR #89) placing orders at limits the market never crosses, not the engine.

## What I confirmed (high confidence)

### 1. The handoff's "0 fills in 3h" was a wrong Loki query

Real numbers (6h window, candidate-a pod): 56 `order_filled` / 357 `place_order.complete` = **15.7% Loki ratio** — non-zero but still well below live.

### 2. The bug.5005 maker-fill pre-pass is shipped and emits diagnostics

`engine.py:474-820` `_apply_maker_fills` runs, calls Polymarket data-api `/trades`, classifies (order × trade) crossings, emits `event=maker_fill_scan_detail` to Loki with `would_match`/`side_mismatch`/`wrong_price` counts. **The diagnostics work.** Previous obs PRs delivered.

### 3. data-api `side` semantics ARE taker (handoff's BBO-only theory dies here)

Verified empirically against high-volume market `0xa0f4...3dd5` (will-bitcoin-hit-150k):

- Orderbook: best_bid=0.007, best_ask=0.008
- `/trades` shows 36 BUY-takers at ~0.008 (hitting the ask) and 11 SELL-takers at ~0.007 (hitting the bid)
- Cogni's filter `(BUY order needs SELL-taker)` is correct

### 4. THE SMOKING GUN — env-by-env from `nodes/poly/research/tenant-matrix/2026-05-18T18-41-03/bundle.json`

| env / role               | placements | filled | canceled |                     fill rate | $real / $intent |
| ------------------------ | ---------: | -----: | -------: | ----------------------------: | --------------: |
| candidate-a / GAP        |        110 |     47 |       63 |                     **42.7%** |           38.1% |
| candidate-a / VALIDATION |        152 |     81 |       70 |                     **53.3%** |           49.7% |
| preview / GAP            |          1 |      0 |        0 | 0% (11 placement_failed errs) |               — |
| preview / TRUST_TWIN     |        272 |     12 |      260 |                      **4.4%** |            3.5% |
| **production / LIVE**    |        113 |     65 |       48 |                     **57.5%** |       **49.6%** |

candidate-a (PAPER) ≈ production (LIVE). Engine works. **preview-twin is the outlier.**

### 5. The findings.json already flagged the right secondary cause

```
"preview has sizing_policy_kind (no mode), candidate-a has both + target_scale.
 PR #89 (sizing-policy dispatch) hasn't reached prod; preview's `policy=auto`
 runs new code, prod runs legacy hardcoded planner. … the 3% decision-mismatch
 may be partially planner-code divergence."
```

This was filed as "secondary"; the data says it's primary.

### 6. Twin places 2.5× more orders than live ($1436 intent vs $412 intent) but realizes 4×less

Strong signal that the twin's planner is placing aggressively at unfillable prices.

## What I disproved

| Hypothesis                                                             | Verdict                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| pm_trader queue model requires limit ≤ BBO (handoff's BBO-only theory) | **Wrong** — verified empirically, engine handles maker-fills via pre-pass and side semantics are right |
| `place_limit_order` not walking the book on entry is the dominant gap  | **Probably wrong** — if it were the dominant gap, candidate-a paper would also be at 4%, not 53%       |
| Data-api `/trades` lag vs 2-min cancel TTL is the dominant gap         | **Probably wrong** — same reason; same lag on both envs                                                |

## What I think is the real root (medium confidence, needs verification)

**Preview's new sizing-policy code (PR #89, `sizing_policy_kind`) computes limit prices that are systematically worse than the legacy planner.** Either:

- It puts BUYs below the bid by too much (planner's `vwap_floor_breach` and `NEVER_PAY_ABOVE_TARGET_VWAP` interaction)
- It sizes orders below market minimum more often (forcing cancel)
- It runs against a different market set (placed 272 orders in 58 markets vs live's 113 in 61 markets — wider, more shallow)

## Acceptance (unchanged from original)

- Paper twin $ filled within ±5% of prod live $ filled over fresh 24h window
- `tenant-matrix-evaluator` Q1 decision fidelity ≥99%
- Regression test pins the contract

## Investigation plan for next agent

**Step 1 — Verify the sidecar is identical (10 min)**

```bash
# Compare candidate-a vs preview sidecar image SHAs
kubectl -n cogni-candidate-a get pod -l app=poly-node-app -o jsonpath='{.items[0].spec.containers[?(@.name=="poly-paper-sidecar")].image}'
kubectl -n cogni-preview get pod -l app=poly-node-app -o jsonpath='{.items[0].spec.containers[?(@.name=="poly-paper-sidecar")].image}'
```

If different SHAs → flight preview to candidate-a SHA and re-measure. If same → skip to step 2.

**Step 2 — Compare planner skip-reason distribution preview-vs-candidate (15 min)**
Already in bundle.json. Preview/TRUST_TWIN skip reasons:

- `below_market_min: 127` (vs candidate-a/VALIDATION: 18 — 7× more!)
- `vwap_floor_breach: 6286` (vs 2961 — 2× more)
- `placement_failed: 54` (vs 0 — twin only)

The `below_market_min` and `placement_failed` divergence is real. Read `nodes/poly/app/src/features/copy-trade/plan-mirror.ts` for the `sizing_policy_kind` branch and trace which sizing-policy preview is on.

**Step 3 — Loki query for preview sidecar place_order.complete with limit_price + best_ask context (20 min)**

```logql
{service="poly-paper-sidecar", env="preview"} |= "place_order.complete" | json
```

Cross-reference each placement's `limit_price` against `book.asks[0]` at the same moment (need to correlate with mirror-pipeline logs that capture book snapshots — already emitted per `mirror-pipeline.ts:1059`). What % of preview placements are marketable on entry (BUY limit ≥ best_ask)?

**Step 4 — Reproduce on candidate-a using preview's tenant config (30 min)**
Push preview's `sizing_policy_kind=auto` config to a candidate-a tenant. If it drops fill rate from 53% → 4%, root cause confirmed.

**Step 5 — Fix in `plan-mirror.ts` (not in pm_trader)** — once root cause is localized.

## Important warnings for next agent

1. **DO NOT TOUCH pm_trader.** Engine works. Both prod-live (CLOB) and candidate-a paper use the same planner code and fill at ~50%. Engine is innocent.
2. **DO NOT bump the resting-sweep TTL** as the user originally suggested. The 2-min TTL works fine for candidate-a paper at 53% fill. Bumping it on preview only would mask the real planner bug.
3. **DO NOT modify `place_limit_order` to walk the book on entry.** Earlier in this session I proposed this; it's only an issue if candidate-a paper was also broken. It's not.
4. **Schema unification is a real coupled issue.** findings.json secondary calls this out. PR #89 needs to reach prod, OR preview needs to roll back to legacy planner. Coordinate with the planner team.

## Confidence in this corrected analysis

- **engine is innocent: 95%** (two-paper-env data point is decisive — candidate-a vs preview have the same engine, different fill rates)
- **root cause is in `plan-mirror.ts` sizing-policy branch: 70%** (high prior from findings.json secondary; below_market_min 7× elevation is suspicious; needs step-4 reproduction to confirm)
- **fixable without touching pm_trader: 90%**

## Pointers

- Bundle (everything I used): `nodes/poly/research/tenant-matrix/2026-05-18T18-41-03/bundle.json`
- Findings (already filed by the matrix tool): `nodes/poly/research/tenant-matrix/2026-05-18T18-41-03/findings.json`
- Maker-fill pre-pass (NOT the bug): `nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/engine.py:474-820`
- Planner sizing branch: `nodes/poly/app/src/features/copy-trade/plan-mirror.ts` (search for `sizing_policy_kind` / `target_scale`)
- Original handoff (now superseded): `work/handoffs/bug.5060.handoff.md`
- Bug item: `https://cognidao.org/api/v1/work/items/bug.5060`

## Open questions

1. Why does the matrix-evaluator findings.json say "decision fidelity 96.9%" yet $ filled is 80% off? Because decision fidelity counts the agreement on `outcome` (placed/skipped/etc.) — placed-on-both decisions account for ~62 rows in top_mismatches, but the **execution** of those placements diverges hugely.
2. PR #89 status on prod — is the path forward (a) ship #89 to prod, or (b) roll back preview to legacy? Charter call.
3. Is there a single env var or feature flag that toggles sizing_policy_kind=auto vs legacy? If yes, the quickest test is flipping it on preview.
