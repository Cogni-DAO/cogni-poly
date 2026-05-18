---
id: chr.poly-algo-tenant-matrix
type: charter
title: "Poly Algo Testing Tenant Matrix"
state: Draft
summary: "Living matrix of the per-(env, tenant) paper-trading accounts we operate for algo iteration + observation. Tracks which sizing policy / target wallet / capital allocation each tenant runs, what hypothesis it serves, and who owns it. Candidate-a is freely mutable (devs A/B at will); preview is the stable prod-twin layer where only thought-through policy changes land. Companion to chr.poly-copy-delta (the failure-mode taxonomy this matrix runs experiments against)."
created: 2026-05-17
updated: 2026-05-17
last_evaluated: 2026-05-17
evaluations: 2
---

# Poly Algo Testing Tenant Matrix

> **Status: DRAFT.** The matrix below is a true snapshot but the project's load-bearing claim — "this charter governs which tenants exist" — is **not yet enforced**. PR #96 (this file) MUST NOT merge until: (a) the matrix is validated against the live ledger by an independent re-query, (b) `.env.cogni.example` carries every key the matrix references, and (c) at least one preview-side `position_gap` row is producing observed activity. See "Stability gates" below.

## Goal

Stand up and maintain a small, deliberate set of paper-trading tenants across `candidate-a` and `preview` so that **every algo change can be A/B'd against a baseline before it touches production**. Each row in the matrix is a (env, tenant, target wallet, sizing policy) tuple with a stated hypothesis. When a delta-minimizer report or charter-D-class finding implies an algo change, the matrix is the substrate that proves the change worked (or didn't).

## How to use this charter

- **When proposing an algo change** (new `SizingPolicy` variant, new gate, new threshold): identify which matrix row is the control, propose which row(s) the change should be tested on, and what observation closes the loop.
- **When closing a delta-minimizer incident**: link the proof tape to the matrix row whose observation surfaced the divergence.
- **When the matrix grows**: every new tenant gets a row here with `purpose`, `policy`, `env_key`, and `cleanup_when`. Tenants without a row in this charter are throwaway and subject to cleanup.
- **Before relying on this charter's matrix for any decision**: re-run the audit query in `## Stability gates`. The data goes stale on every `POST /api/v1/poly/copy-trade/targets` against any env.

## Audit method (and a correction)

The matrix below is built from `poly_copy_trade_decisions` grouped by `billing_account_id` over the last 24h, NOT from a JOIN against `poly_copy_trade_targets.id`. The ledger's `target_id` column is the deterministic `uuidv5(target_wallet)`, shared across tenants — **not** the row PK of the target record. An earlier draft of this charter joined on the row PK and incorrectly concluded that 4 active candidate-a tenants had zero activity. They do not; they're producing tens of thousands of decisions per day. The correct correlation is `(billing_account_id, target_wallet)`. Every "activity" cell in the tables below was sourced from the ledger directly.

## Discipline by environment

| ENV                                      | DISCIPLINE                                                                                       | WHO MUTATES                | WHAT FLOWS                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------- |
| `candidate-a` (`poly-test.cognidao.org`) | freely mutable — devs flip policies, register/delete tenants at will                             | any agent or human dev     | every code change in any open PR after `candidate-flight`     |
| `preview` (`poly-preview.cognidao.org`)  | stable, deliberate — policy changes require a charter update first                               | curated set of agents only | code merged to main; promoted via the preview-flight pipeline |
| `production` (`poly.cognidao.org`)       | append-only history — never used for A/B; lives behind charter `chr.poly-copy-delta` proof gates | derek's real wallet only   | code that survived ≥1 preview matrix cycle                    |

**Why the candidate-a / preview split matters:** candidate-a is for "did the code path execute the way I expected?" (per-PR `/validate-candidate` exercises). Preview is for "did the algo behave the way I expected over hours/days of real target activity?" (cross-PR, accumulating evidence). Mixing the two collapses both questions and we lose the signal.

## Projects

Each row below is a live paper-trading tenant — the unit of A/B iteration this charter governs. Activity is the ledger count from the last 24h.

### Candidate-a — freely mutable

| TENANT (short) | TARGET WALLET       | POLICY                                | OWNER ENV-KEY     | DECISIONS / PLACED (24h) | PURPOSE                                                                      | DISPOSITION                                                                                                                                                 |
| -------------- | ------------------- | ------------------------------------- | ----------------- | ------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20fdb57a`     | swisstony           | `auto` (= `target_percentile_scaled`) | **none — orphan** | 36,603 / 2,309           | unknown — likely a dev-session throwaway from 2026-05-16                     | **consolidation candidate** — three identical-policy rows below produce duplicate signal; collapse to one canonical                                         |
| `acd63233`     | swisstony           | `auto` (= `target_percentile_scaled`) | **none — orphan** | 34,158 / 2,302           | unknown — likely a dev-session throwaway from 2026-05-16                     | **consolidation candidate** (same as above)                                                                                                                 |
| `809e37f7`     | swisstony           | `auto` (= `target_percentile_scaled`) | **none — orphan** | 34,169 / 2,304           | unknown — likely a dev-session throwaway from 2026-05-16                     | **consolidation candidate** (same as above)                                                                                                                 |
| `f472b6ad`     | RN1 (`0x2005…75ea`) | **position_gap** p80 / $15            | **none — orphan** | 1,190 / **0**            | D2 phase 2 — first live `position_gap` target, registered after PR #92 merge | 🔴 **0 placed in 24h** — gap math may be too restrictive for RN1's position size; needs investigation before this row is trusted as the A/B evidence source |

**What "orphan" means here (corrected):** no entry in `.env.cogni` carries this tenant's agent API key. The tenant is still active — the cross-tenant mirror enumerator (`dbTargetSource.listAllActive`, BYPASSRLS) runs it regardless of whether anyone has the key. "Orphan" = "no agent can drive PATCH/DELETE against it from outside session-cookie HTTP." It does NOT mean "inert."

### Preview — stable, deliberate

| TENANT (short)          | TARGET WALLET | POLICY                                          | OWNER ENV-KEY               | DECISIONS / PLACED (24h) | PURPOSE                                                                  | DISPOSITION                                                                  |
| ----------------------- | ------------- | ----------------------------------------------- | --------------------------- | ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `fb8f65d5` (trust-twin) | swisstony     | `auto` (= `target_percentile_scaled` p80 / $15) | `POLY_PREVIEW_TRUST_TWIN_*` | 8,580 / 43               | baseline — paper-mirror of derek's real prod wallet on the legacy policy | 🟡 keep; this is the prod-twin trust anchor. Currently the only preview row. |

### Gap

🔴 **Preview has ONE tenant.** The "multi-tenant paper-twin matrix" the project needs to A/B `position_gap` vs `target_percentile_scaled` does NOT exist on preview yet.
🔴 **`position_gap` produced ZERO placements on candidate-a in 24h** (`f472b6ad`, RN1). Either RN1's positions are too small for `target_scale = 1e-4` (math: typical RN1 trade is 10–100 sh × 1e-4 = 0.001–0.01 desired sh; below any market floor) OR the planner's gap-negative skip is firing for a different reason. Either way, **before any preview row gets pinned to `position_gap`, the candidate-a behavior must be explained**. Otherwise we'll just stand up an inert experiment on preview too.

## Target preview matrix (the "stable, deliberate" side we're building toward)

Three preview paper tenants, all mirroring swisstony (NOT RN1 — swisstony has the volume to produce meaningful per-policy delta) on the same percentile + max-bet so the only variable is the sizing kind. Diff between any two = the policy delta.

| ROLE                   | TENANT                                                                           | POLICY                                                   | PURPOSE                                                                    | EXPECTED OUTCOME                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swiss-tps-control`    | reuse `fb8f65d5` (exists; pin from `auto` → explicit `target_percentile_scaled`) | `target_percentile_scaled` p80 / $15                     | baseline — what production runs today                                      | mirrors derek's prod wallet within `paper-twin-diff` tolerance                                                                                           |
| `swiss-gap-experiment` | NEW                                                                              | `position_gap` (default `target_scale = 1e-4`) p80 / $15 | tests D2 phase 2 against the control on real target activity               | minority-side delta materially lower than control; primary-side delta comparable or better — IF the scale produces non-zero placements (see Gap section) |
| `swiss-minbet-floor`   | NEW                                                                              | `min_bet` $5                                             | sanity floor — should under-mirror everything, marks the lower-bound shape | tiny positions on every fill regardless of target shape; never beats the baseline                                                                        |

`paper-twin-diff.ts` (shipped via PR #93 once it lands) reports each tenant against the prod control.

## Constraints

What blocks driving the preview matrix from 1 tenant to the 3-row target state, AND what blocks merging this charter:

- **`position_gap` produces zero placements on the only live experiment.** Until the candidate-a RN1 row (`f472b6ad`) shows >0 placed decisions OR the zero is explained as expected behavior, standing up a `position_gap` row on preview is premature — it would just replicate the same zero.
- **No `.env.cogni.example`.** The current `.env.cogni` is real-only; there is no checked-in template documenting the per-tenant key shape (`POLY_<ENV>_<ROLE>_{API_KEY,USER_ID,BILLING_ACCOUNT_ID,TARGET_ID,TARGET_WALLET,CONFIG}`). Without that, future agents can't discover what keys the matrix expects, and the matrix degrades on every new tenant.
- **No standard recipe for issuing agent API keys to new paper tenants.** The `POLY_PREVIEW_TRUST_TWIN_*` env vars exist because someone went through the `/contribute-to-cogni` register flow once. Repeating that for two more tenants is not yet documented; the registration sequence should be a one-line script or a runbook.
- **No standing observation surface for the matrix.** `/validate-candidate` is per-PR. `paper-twin-diff.ts` is per-invocation. Continuous matrix observation (the thing this charter wants) requires either a scheduled `/loop` job or a Grafana dashboard backed by `poly_copy_trade_decisions` filtered by `(env, billing_account_id, target_wallet)`. Neither exists yet.
- **v0 capital cap of $15 per trade on preview tenants.** Hard cap from `mirror_max_usdc_per_trade`. The matrix measures _delta from target_, not P/L magnitude — these will diverge at v1 cap loosening, by design.
- **Three duplicate swisstony rows on candidate-a producing nearly identical decision streams.** Wasteful — same policy, same target, same fills → ~33k decisions each, all the same shape. Consolidation to one canonical row would cut the noise; deletion of the duplicates needs a soft-delete (preserves ledger history).

## Stability gates (must clear before PR #96 merges)

This charter is intentionally `state: Draft` until ALL of:

- [ ] Audit query below re-run by an independent agent or human; activity counts in the Projects tables match (±10% drift acceptable).
- [ ] `.env.cogni.example` checked in, documenting every `POLY_<ENV>_<ROLE>_*` key the matrix references (real values redacted).
- [ ] At least one preview-side `position_gap` row exists AND has produced >0 placed decisions in a 24h window.
- [ ] The candidate-a RN1 `position_gap` row's 0-placements is either resolved (gap math fix or `target_scale` tuning) or explicitly documented as expected (e.g., "RN1's typical trade size × 1e-4 is below market floor").
- [ ] PR #93 (`paper-twin-diff.ts`) merged so the matrix has a diff tool to point at.

### Audit query

```sql
-- Run against each env (candidate-a, preview) via scripts/grafana-postgres-query.sh.
-- The 'orphan' status is derived from .env.cogni at audit time, not the DB.
SELECT
  billing_account_id,
  COUNT(*) AS decisions,
  COUNT(*) FILTER (WHERE outcome = 'placed') AS placed,
  MAX(decided_at) AS latest
FROM poly_copy_trade_decisions
WHERE decided_at > NOW() - INTERVAL '24 hours'
GROUP BY billing_account_id
ORDER BY decisions DESC;
```

## Cleanup / consolidation policy

A tenant is a **consolidation candidate** when ALL of:

- It has no row in this charter's current matrix.
- Another tenant on the same env runs the same `(target_wallet, sizing_policy_kind, mirror_*)` configuration.
- The owner is `none` (no env key in `.env.cogni`).

**Consolidation action:** soft-delete via direct `UPDATE poly_copy_trade_targets SET disabled_at = NOW() WHERE id = …` (the API DELETE path also works if you have a session). NEVER hard-delete — ledger rows reference `(billing_account_id, target_id)` and lose provenance on row removal. Soft-delete is reversible; hard-delete is not.

**Consolidation cadence:** opportunistic + before every new matrix row is added (so the matrix stays a true picture). Not a scheduled job in v0.

**Caveat — candidate-a is freely mutable by design.** Consolidation on candidate-a is hygiene, not correctness. On preview, the same policy is stricter: any tenant without a charter row is suspect because preview is supposed to be deliberate.

## Open items

- **2026-05-17:** **Investigate why `f472b6ad` (RN1 / position_gap) has 1,190 decisions and 0 placements.** Top hypothesis: RN1's typical position size × `target_scale = 1e-4` falls below `applyMarketFloors`'s effective floor on every fill → every decision skips `below_market_min`. If true, fix is either per-target `target_scale` (deferred from Phase 2 to a follow-up PR) OR a higher default scale for low-volume targets.
- **2026-05-17:** Draft `.env.cogni.example` with the full `POLY_<ENV>_<ROLE>_*` key shape. Required for stability gate #2.
- **2026-05-17:** Decide consolidation policy for the 3 duplicate swisstony rows on candidate-a. They produce identical signal; consolidating to 1 canonical row reduces noise but loses some redundancy. Recommend: keep one, soft-delete two, but only AFTER the position_gap investigation closes (in case any of them turn out to be useful as additional experiments).
- **TBD:** branch `/validate-candidate` into `/validate-paper-matrix` — a recurring observation that enumerates this matrix's preview rows + queries Loki + the diff tool per row.
- **TBD:** Grafana dashboard for matrix observation — single panel per row, decisions/placed/skip-reasons over time, side-by-side.

## Pointers

- `chr.poly-copy-delta` — the failure-mode taxonomy this matrix runs experiments against
- `docs/spec/poly-copy-trade-position-mirror.md` — the D2 phase plan whose phase-2 done condition lives in this matrix
- `.claude/skills/validate-candidate/SKILL.md` — per-PR exercise; this matrix is the cross-PR continuous version
- `.claude/skills/paper-trade-diff-analysis/SKILL.md` — the diff tool that consumes matrix rows
- `nodes/poly/scripts/paper-twin-diff.ts` — implementation (lands via PR #93)
- `.env.cogni` — current per-env API keys (POLY*PROD_TENANT*_, POLY*PREVIEW_TRUST_TWIN*_); MUST be mirrored by `.env.cogni.example` per stability gate #2
- `nodes/poly/app/src/features/copy-trade/target-source.ts` — `dbTargetSource.listAllActive` (the BYPASSRLS enumerator that runs every active target regardless of agent API key ownership)
- `nodes/poly/packages/db-schema/src/copy-trade.ts` — `poly_copy_trade_targets` row PK vs ledger `target_id` (= deterministic uuidv5(target_wallet)); confusing the two was the source of an earlier wrong audit
