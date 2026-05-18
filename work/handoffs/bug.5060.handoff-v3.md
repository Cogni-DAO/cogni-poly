---
id: bug.5060.handoff-v3
type: handoff
title: "PR #89 hypothesis dies — divergence isolated to 4 post-flight PRs (#92/#94/#98/#102)"
work_item: bug.5060
project: proj.poly-paper-trading
created: 2026-05-18
supersedes: work/handoffs/bug.5060.handoff-v2.md
author: claude (brisbane-v2 pickup, ~30m diagnosis)
severity: critical
status_for_next_agent: needs_implement (root cause set narrowed; needs reproduction step 4)
---

# bug.5060 — handoff v3

## TL;DR

Handoff-v2's core finding (engine is innocent) holds. **Its PR-#89 attribution is wrong.** PR #89 is in candidate-a's deployed image (the flighted SHA `414d2439` is downstream of #89's merge `06d3f555c`). The real divergence between candidate-a (53% fills) and preview (4% fills) is a set of 4 PRs that merged to main AFTER candidate-a's last successful flight at 2026-05-18T00:20 UTC.

## Step 1 — closed

Pulled both kustomization overlays directly (no kubectl needed):

| Env         | poly-paper-sidecar digest | app digest             |
| ----------- | ------------------------- | ---------------------- |
| candidate-a | `sha256:e96106e8…d014`    | `sha256:bae51481…793d` |
| preview     | `sha256:e96106e8…d014`    | `sha256:78af980b…90b8` |

Sidecar identical. Engine is innocent — definitively. App images differ.

## Smoking gun (replaces v2's "PR #89")

`/version` endpoint mapping:

- `https://poly.cognidao.org/version` → `80eb171e54df297098e60c8b2b7c90c0aa25b3ba` (prod, older)
- `https://poly-preview.cognidao.org/version` → `4791f348cdf2ed097bff4b84d2f7ea4707a156e8` (= main HEAD at bundle time)
- `https://poly-test.cognidao.org/version` → 502 (gateway-gated)
- Last successful `candidate-flight.yml` run: branch `derekg1729/poly-paper-twin-diff-html-report` at `414d2439` — that's the git SHA in candidate-a's image.

`git log 414d2439..4791f348 -- nodes/poly/app/` yields **6 commits in preview that candidate-a does NOT have**:

| PR   | SHA       | Title                                                        | Merged (UTC)      | Plausibility                                                         |
| ---- | --------- | ------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------- |
| #92  | c108b96f3 | `position_gap` SizingPolicy variant (D2 phase 2) — task.5001 | 2026-05-17T21:43Z | **HIGH** — 119 lines `plan-mirror.ts`                                |
| #94  | 389f81337 | position_gap floor-clamp leak + drop dead export             | 2026-05-18        | LOW                                                                  |
| #98  | 473e68775 | one source of truth for execution mode (task.5003)           | 2026-05-18T17:40Z | **MEDIUM** — refactor crosses mirror-pipeline + ledger + plan-mirror |
| #100 | 4791f348c | task.5048 tenant-matrix-evaluator                            | 2026-05-18T18:50Z | NONE (research only)                                                 |
| #102 | 36613c9b7 | per-target target_scale column for position_gap              | 2026-05-18T18:17Z | MEDIUM — DB schema + bootstrap                                       |
| #93  | a82d9e7d8 | paper-twin-diff HTML report                                  | —                 | NONE (research only)                                                 |

PR #89 itself: `06d3f555c` — landed BEFORE 414d2439. **It is in candidate-a's image already.** Cannot be the cause.

## TRUST_TWIN config identical to VALIDATION

Both `POLY_PREVIEW_TENANT_TRUST_TWIN_CONFIG` and `POLY_CANDIDATE_A_TENANT_VALIDATION_CONFIG` resolve to `p80_max15_swisstony`. Same target wallet (`0x204f72f3…5e14`). Same paper sidecar binary. Different app binary. Therefore the divergence is _purely_ in the app code — and the diff set above is the entire suspect.

## Window caveat (this is why we need to re-run)

`bundle.json` window: 2026-05-17T18:40 → 2026-05-18T18:40 UTC. Preview's image rolled forward at each merge during that window. The bundle's 4% fill rate is the _aggregate_ across multiple preview images, not a clean signal for any single PR. **A re-measure on a stable preview image is needed before assigning blame.**

## Recommended next steps (order is load-bearing)

### Step A (10 min, decisive) — flight current main HEAD to candidate-a

`bug-5060-paper-engine-fill-fix` branch HEAD is `ce39f7287` (one docs commit above main). Flight it to candidate-a via `POST /api/v1/vcs/flight` (after opening a no-op or stub PR — flight gates on PR number, not branch). Wait 2h, re-run `/tenant-matrix-evaluator`. Two outcomes:

- **candidate-a/VALIDATION drops to ~4%** → root cause is in main → bisect by reverting #102 → re-flight → re-measure → if still bad, revert #98 → re-measure → if still bad, revert #92. Each round is one flight + 2h.
- **candidate-a/VALIDATION stays ~53%** → bug is preview-specific (DB rows, env vars, VM perf). Investigate cogni-preview namespace + Postgres state.

### Step B (15 min) — Loki distribution of `mirror pipeline: placement error`

```logql
{namespace="cogni-preview", app="node-app"} |= "placement error" | json | line_format "{{.errorCode}} {{.errorReason}} {{.errorClass}}"
```

54 `placement_failed` errors on preview vs 0 on candidate-a is a separate, smaller divergence. Whatever the `error_code` is will narrow the root cause faster than bisect.

### Step C (charter call — block on user) — Roll-forward vs roll-back

**Question for Derek:** if Step A confirms a regression in #92 / #98 / #102, do we:

- (a) Find + ship the fix forward (preserves Phase-2 work), or
- (b) Roll back the offending PR on preview + main, leaving Phase-2 work as a follow-up?

Phase-2 (position_gap) is on the critical path for the D2 charter. Rolling it back has a project cost. Don't decide unilaterally.

### Step D (after fix flights) — close per CLAUDE.md DoD

- Open PR with regression test pinning placement under `target_percentile` sizing against the same fixture conditions where preview dropped.
- CI green → `/vcs/flight` to candidate-a → /validate-candidate scorecard → re-run matrix-evaluator on the stable preview image once promoted. Fill rate ≥40% within 2h, ≥99% Q1 fidelity within 24h.
- `deployVerified: true` only after the post-promotion matrix confirms T1.

## What I did NOT do (and why)

- **Did not touch pm_trader / paper-sidecar** — confirmed identical across envs.
- **Did not modify plan-mirror.ts NEVER_PAY_ABOVE_TARGET_VWAP / resting-sweep TTL** — handoff-v2 explicit warning still holds.
- **Did not flight anything yet** — wanted user direction first per the charter-call requirement in the original brief.
- **Did not patch `summary` on the work item** — the cogni-poly work-items API has no comment sub-route per CLAUDE.md, and overwriting `summary` destroys history. v3 file IS the heartbeat.

## Confidence

- engine innocent: 98% (sidecar digest identical, decisive)
- root cause in the diff-set {#92, #94, #98, #102}: 85% (configs+wallet identical, only code differs, suspects are well-bounded)
- root cause is #92 specifically: 50% (largest plan-mirror.ts surface change, but shared codepath with target_percentile is small)
- fixable without redesign: 85%

## Pointers (unchanged from v2 where relevant)

- v2 handoff (now superseded): `work/handoffs/bug.5060.handoff-v2.md`
- Bundle: `nodes/poly/research/tenant-matrix/2026-05-18T18-41-03/bundle.json`
- Kustomization (preview): `infra/k8s/overlays/preview/poly/kustomization.yaml`
- Kustomization (candidate-a): `infra/k8s/overlays/candidate-a/poly/kustomization.yaml`
- Engine (verified innocent): `nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/engine.py`
- Planner: `nodes/poly/app/src/features/copy-trade/plan-mirror.ts`
- Work item: `https://cognidao.org/api/v1/work/items/bug.5060`
