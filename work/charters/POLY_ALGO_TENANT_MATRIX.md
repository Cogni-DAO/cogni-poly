---
id: chr.poly-algo-tenant-matrix
type: charter
title: "Poly Algo Testing Tenant Matrix"
state: Draft
summary: "Living matrix of the per-(env, tenant) paper-trading accounts we operate for algo iteration + observation. Tracks which sizing policy / target wallet / capital allocation each tenant runs, what hypothesis it serves, and who owns it. Candidate-a is freely mutable (devs A/B at will); preview is the stable prod-twin layer where only thought-through policy changes land. Companion to chr.poly-copy-delta (the failure-mode taxonomy this matrix runs experiments against)."
created: 2026-05-17
updated: 2026-05-19
last_evaluated: 2026-05-19
evaluations: 4
---

# Poly Algo Testing Tenant Matrix

> **Status: DRAFT.** The matrix below is a true snapshot. PR #96 (this file) MUST NOT merge until both stability gates clear: (a) the matrix is validated against the live ledger by an independent re-query, (b) `.env.cogni.example` carries every key the matrix references. Per-row experiment outcomes (e.g. RN1's 0-placements under `position_gap`) are matrix observations, NOT charter blockers — the charter governs how we run experiments, not whether any specific one is green.

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

| TENANT (short) | TARGET WALLET       | ALGO POLICY REF                                                   | ALGO POLICY CONFIG             | OWNER ENV-KEY                          | DECISIONS / PLACED (24h) | DISPOSITION                                                                                                                                   |
| -------------- | ------------------- | ----------------------------------------------------------------- | ------------------------------ | -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `20fdb57a`     | swisstony           | `target_percentile_scaled` (via `auto`)                           | p75 / $5                       | **none — orphan**                      | 36,603 / 2,309           | **consolidation candidate** — three identical-policy rows below produce duplicate signal; collapse to one canonical                           |
| `acd63233`     | swisstony           | `target_percentile_scaled` (via `auto`)                           | p75 / $5                       | **none — orphan**                      | 34,158 / 2,302           | **consolidation candidate** (same)                                                                                                            |
| `809e37f7`     | swisstony           | `target_percentile_scaled` (via `auto`)                           | p75 / $5                       | **none — orphan**                      | 34,169 / 2,304           | **consolidation candidate** (same)                                                                                                            |
| `f472b6ad`     | RN1 (`0x2005…75ea`) | `position_gap`                                                    | legacy `target_scale=1e-4`     | **none — orphan**                      | 1,190 / **0**            | 🔴 D2 phase-2 experiment producing 0 placements — gap math may be below market floor for RN1's volume; investigation pending                  |
| `1890787d`     | swisstony           | `target_percentile_scaled` (via `auto`)                           | p80 / $15                      | `POLY_CANDIDATE_A_TENANT_VALIDATION_*` | (just registered)        | 🟡 cand-a counterpart to the preview trust-twin; drives `/validate-candidate` exercises                                                       |
| `d66032aa`     | swisstony           | `target_percentile_scaled` (via `auto`) — slot for `position_gap` | p75 / $5 (default until PATCH) | `POLY_CANDIDATE_A_TENANT_GAP_*`        | (just registered)        | 🟡 PENDING — cand-a is on stale SHA `414d2439` (PR #93 head, pre-PR #92 contract); after re-flight from main, PATCH to `position_gap` p80/$15 |

**What "orphan" means here (corrected):** no entry in `.env.cogni` carries this tenant's agent API key. The tenant is still active — the cross-tenant mirror enumerator (`dbTargetSource.listAllActive`, BYPASSRLS) runs it regardless of whether anyone has the key. "Orphan" = "no agent can drive PATCH/DELETE against it from outside session-cookie HTTP." It does NOT mean "inert."

### Preview — stable, deliberate

| TENANT (short)                    | TARGET WALLET | ALGO POLICY REF                         | ALGO POLICY CONFIG | OWNER ENV-KEY                                | DECISIONS / PLACED (post-reset sample) | DISPOSITION                                                                                                                                                                                                             |
| --------------------------------- | ------------- | --------------------------------------- | ------------------ | -------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eae447b1` (trust-twin)           | swisstony     | `target_percentile_scaled` (via `auto`) | p80 / $15          | `POLY_PREVIEW_TENANT_TRUST_TWIN_*`           | 18 / 1                                 | 🟢 **RESET 2026-05-19T21:32Z** — fresh paper-mirror of derek's prod wallet on the legacy policy; THE control. Old `fb8f65d5` row is soft-disabled, not deleted, due pre-bug.5018 columnless ledger contamination.       |
| `0e16cf1a` (swiss-gap)            | swisstony     | `position_gap`                          | alloc=$1,000       | `POLY_PREVIEW_TENANT_GAP_*`                  | 18 / 0                                 | 🟢 **RESET 2026-05-19T21:32Z**; bumped from `$5` to `$1,000` at 2026-05-19T21:56Z after confirming pXX/max are inert under `position_gap`. Old `376c594c` row is soft-disabled, not deleted.                            |
| `b0ca1bce` (swisstony-trust-twin) | swisstony     | `position_gap`                          | alloc=$500,000     | `POLY_PREVIEW_TENANT_SWISSTONY_TRUST_TWIN_*` | 18 / 6                                 | 🟢 **RESET 2026-05-19T21:32Z** — production-volume position_gap mirror of swisstony. First reset sample: 4 realized rows, 4 with `price/shares/fees_usdc`, 0 missing. Old `13c81ec7` row is soft-disabled, not deleted. |

### Gap

🟢 **Preview matrix reset at 2026-05-19T21:32Z** — control (trust-twin, tps), practical small-budget experiment (swiss-gap, position_gap @ $1k alloc), and production-volume experiment (swisstony-trust-twin, position_gap @ $500k alloc) now live on fresh tenant/billing accounts. The old preview rows remain soft-disabled for provenance because their ledgers contain pre-bug.5018 columnless paper fills. First reset report: `nodes/poly/research/tenant-matrix/2026-05-19T21-32Z-post-trust-twin-reset/report.html`.
🔴 **`position_gap` @ bootstrap-default alloc produces ZERO placements** on both `f472b6ad` (cand-a, RN1) and `376c594c` (preview, swisstony). PR #103 dropped `target_scale` in favor of `mirror_capital_alloc_usdc` as the single proportionality knob — the bootstrap default is too low for either target's book size, so the planner skips with `below_market_min`/`below_target_percentile` on every fill. The `swisstony-trust-twin` row at `$500k` directly tests the hypothesis that scale, not policy, is the gating factor.

## Target preview matrix (the "stable, deliberate" side we're building toward)

Three preview paper tenants, all mirroring swisstony (NOT RN1 — swisstony has the volume to produce meaningful per-policy delta). Legacy `target_percentile_scaled` rows are described by percentile + max; `position_gap` rows are described by `mirror_capital_alloc_usdc` only because pXX and max-bet are not active knobs for that policy.

| ROLE                   | TENANT     | POLICY                                                      | PURPOSE                                                                                             | EXPECTED OUTCOME                                                                                                                                                                                     |
| ---------------------- | ---------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swiss-tps-control`    | `eae447b1` | `target_percentile_scaled` p80 / $15                        | baseline — what production runs today                                                               | mirrors derek's prod wallet within `paper-twin-diff` tolerance                                                                                                                                       |
| `swiss-gap-small`      | `0e16cf1a` | `position_gap` @ `mirror_capital_alloc_usdc=1000`           | practical small-budget experiment — tests whether gap math routes at a usable but bounded book size | should produce fewer placements than the $500k paper row but avoid the artificial all-zero floor failure of `$5` alloc                                                                               |
| `swisstony-trust-twin` | `b0ca1bce` | `position_gap` @ `mirror_capital_alloc_usdc=500000` (paper) | production-volume experiment — tests D2 phase 2 at the upper-mid of swisstony's typical book        | scale oscillates ~0.83–1.67 around 1.0 over the natural $300-600k book range; placement volume dwarfs the legacy-cap'd control by 1000×, quantifying how much signal the $15 cap is dropping on prod |
| `swiss-minbet-floor`   | NEW        | `min_bet` $5                                                | sanity floor — should under-mirror everything, marks the lower-bound shape                          | tiny positions on every fill regardless of target shape; never beats the baseline                                                                                                                    |

`paper-twin-diff.ts` (shipped via PR #93 once it lands) reports each tenant against the prod control.

## Constraints

What blocks driving the preview matrix from 1 tenant to the 3-row target state, AND what blocks merging this charter:

- **`position_gap` produces zero placements on the only live experiment.** Until the candidate-a RN1 row (`f472b6ad`) shows >0 placed decisions OR the zero is explained as expected behavior, standing up a `position_gap` row on preview is premature — it would just replicate the same zero.
- **`.env.cogni.example` exists but must stay in lockstep.** Every matrix role needs `POLY_<ENV>_<ROLE>_{API_KEY,USER_ID,BILLING_ACCOUNT_ID,TARGET_ID,TARGET_WALLET,CONFIG}` placeholders where applicable. Future tenant rotations must update the real root `.env.cogni` first, then this checked-in template shape.
- **No standard recipe for issuing agent API keys to new paper tenants.** The `POLY_PREVIEW_TENANT_TRUST_TWIN_*` env vars exist because someone went through the `/contribute-to-cogni` register flow once. Repeating that for two more tenants is not yet documented; the registration sequence should be a one-line script or a runbook.
- **No standing observation surface for the matrix.** `/validate-candidate` is per-PR. `paper-twin-diff.ts` is per-invocation. Continuous matrix observation (the thing this charter wants) requires either a scheduled `/loop` job or a Grafana dashboard backed by `poly_copy_trade_decisions` filtered by `(env, billing_account_id, target_wallet)`. Neither exists yet.
- **The target-row contract is flatter than the planner contract.** Hard cap from `mirror_max_usdc_per_trade` still applies under `target_percentile_scaled` / `auto`. Under `position_gap` (PR #103), `mirror_filter_percentile` and `mirror_max_usdc_per_trade` are inert legacy columns; the only active sizing knob is `mirror_capital_alloc_usdc` (whole-book budget). Per-tenant daily/hourly caps live downstream at `authorizeIntent` via `poly_wallet_grants`. The matrix measures _delta from target_, not P/L magnitude.
- **Three duplicate swisstony rows on candidate-a producing nearly identical decision streams.** Wasteful — same policy, same target, same fills → ~33k decisions each, all the same shape. Consolidation to one canonical row would cut the noise; deletion of the duplicates needs a soft-delete (preserves ledger history).

## Stability gates (must clear before PR #96 merges)

Two gates. Both are about whether this charter can be trusted as governance, not about whether any specific experiment is green.

- [ ] Audit query below re-run by an independent agent or human; activity counts in the Projects tables match (±10% drift acceptable).
- [x] `.env.cogni.example` checked in, documenting every `POLY_<ENV>_<ROLE>_*` key the matrix references (real values redacted, shape complete).

Per-row outcomes (RN1's 0-placements, PR #93 not yet shipped, etc.) live in "Open items" and accumulate over time. They never block the charter itself.

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

- **2026-05-17 (open, separate dev assigned):** **`mode` column anti-pattern.** `poly_copy_trade_targets.mode` defaults to `'live'` and is NOT restamped when `PAPER_ENFORCE_MODE=paper` actually routes the executor through the paper sidecar. So on candidate-a + preview, every target row reads `mode='live'` even though every placement is paper. Effects: (a) `paper-twin-diff.ts` default `mode=paper` filter returns 0 rows on cand-a (it filters by the column, not by actual routing) and needs `mode=all`, (b) charter matrix's "mode" column is meaningless until this resolves. Surfaced by PR #93 /validate-candidate scorecard. Other dev is on it.
- **2026-05-17 → 2026-05-19 (superseded by PR #103 + swisstony-trust-twin row):** **Investigate why `f472b6ad` (RN1 / position_gap) has 1,190 decisions and 0 placements.** Original hypothesis was that `target_scale = 1e-4` was too small. PR #103 dropped `target_scale` entirely and replaced it with `mirror_capital_alloc_usdc`. The `swisstony-trust-twin` row at $500k alloc is now the direct test of "is allocation the gating factor"; if it places at scale comparable to trust-twin, the bootstrap-default rows can be re-allocated rather than the policy redesigned again.
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
