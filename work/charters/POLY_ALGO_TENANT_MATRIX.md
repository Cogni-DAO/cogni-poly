---
id: chr.poly-algo-tenant-matrix
type: charter
title: "Poly Algo Testing Tenant Matrix"
state: Active
summary: "Living matrix of the per-(env, tenant) paper-trading accounts we operate for algo iteration + observation. Tracks which sizing policy / target wallet / capital allocation each tenant runs, what hypothesis it serves, and who owns it. Candidate-a is freely mutable (devs A/B at will); preview is the stable prod-twin layer where only thought-through policy changes land. Companion to chr.poly-copy-delta (the failure-mode taxonomy this matrix runs experiments against)."
created: 2026-05-17
updated: 2026-05-17
last_evaluated: 2026-05-17
evaluations: 1
---

# Poly Algo Testing Tenant Matrix

## Goal

Stand up and maintain a small, deliberate set of paper-trading tenants across `candidate-a` and `preview` so that **every algo change can be A/B'd against a baseline before it touches production**. Each row in the matrix is a (env, tenant, target wallet, sizing policy) tuple with a stated hypothesis. When a delta-minimizer report or charter-D-class finding implies an algo change, the matrix is the substrate that proves the change worked (or didn't).

## How to use this charter

- **When proposing an algo change** (new `SizingPolicy` variant, new gate, new threshold): identify which matrix row is the control, propose which row(s) the change should be tested on, and what observation closes the loop.
- **When closing a delta-minimizer incident**: link the proof tape to the matrix row whose observation surfaced the divergence.
- **When the matrix grows**: every new tenant gets a row here with `purpose`, `policy`, `env_key`, and `cleanup_when`. Tenants without a row in this charter are throwaway and subject to cleanup.

## Discipline by environment

| ENV                                      | DISCIPLINE                                                                                       | WHO MUTATES                | WHAT FLOWS                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------- |
| `candidate-a` (`poly-test.cognidao.org`) | freely mutable — devs flip policies, register/delete tenants at will                             | any agent or human dev     | every code change in any open PR after `candidate-flight`     |
| `preview` (`poly-preview.cognidao.org`)  | stable, deliberate — policy changes require a charter update first                               | curated set of agents only | code merged to main; promoted via the preview-flight pipeline |
| `production` (`poly.cognidao.org`)       | append-only history — never used for A/B; lives behind charter `chr.poly-copy-delta` proof gates | derek's real wallet only   | code that survived ≥1 preview matrix cycle                    |

**Why the candidate-a / preview split matters:** candidate-a is for "did the code path execute the way I expected?" (per-PR `/validate-candidate` exercises). Preview is for "did the algo behave the way I expected over hours/days of real target activity?" (cross-PR, accumulating evidence). Mixing the two collapses both questions and we lose the signal.

## Projects

Each row below is a live or proposed paper-trading tenant — the unit of A/B iteration this charter governs. Rows are grouped by env and ranked by priority for the next observation cycle.

### Current matrix (snapshot 2026-05-17)

### Candidate-a — freely mutable

| TARGET ID (short) | TENANT (short) | TARGET WALLET       | POLICY                     | OWNER ENV-KEY     | ACTIVITY                                                     | PURPOSE                                                                      | CLEANUP WHEN                                                                    |
| ----------------- | -------------- | ------------------- | -------------------------- | ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `773a9670`        | `f472b6ad`     | RN1 (`0x2005…75ea`) | **position_gap** p80 / $15 | none              | 🟡 0 decisions, 0 active conns                               | D2 phase 2 — first live `position_gap` target, registered after PR #92 merge | keep until D2 phase 2 done condition (A/B vs `target_percentile_scaled`) closes |
| `144af790`        | `20fdb57a`     | swisstony           | auto                       | **none — orphan** | 🔴 0 decisions, 0 fills, 0 active conns (created 2026-05-16) | unknown (dev throwaway)                                                      | **cleanup candidate** — soft-delete                                             |
| `8336d723`        | `acd63233`     | swisstony           | auto                       | **none — orphan** | 🔴 0 decisions, 0 fills, 0 active conns (created 2026-05-16) | unknown (dev throwaway)                                                      | **cleanup candidate** — soft-delete                                             |
| `6e8264f4`        | `809e37f7`     | swisstony           | auto                       | **none — orphan** | 🔴 0 decisions, 0 fills, 0 active conns (created 2026-05-16) | unknown (dev throwaway)                                                      | **cleanup candidate** — soft-delete                                             |

### Preview — stable, deliberate

| TARGET ID (short) | TENANT (short)          | TARGET WALLET | POLICY                                          | OWNER ENV-KEY               | ACTIVITY                       | PURPOSE                                                                  | CLEANUP WHEN                               |
| ----------------- | ----------------------- | ------------- | ----------------------------------------------- | --------------------------- | ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------ |
| `fc326213`        | `fb8f65d5` (trust-twin) | swisstony     | `auto` (= `target_percentile_scaled` p80 / $15) | `POLY_PREVIEW_TRUST_TWIN_*` | 🟡 ACTIVE — paper twin of prod | baseline — paper-mirror of derek's real prod wallet on the legacy policy | never — this is the prod-twin trust anchor |

### Gap

🔴 **Preview has ONE tenant.** The "multi-tenant paper-twin matrix" the project needs to A/B `position_gap` vs `target_percentile_scaled` does NOT exist on preview yet. Building it is the headline next step.

## Target preview matrix (the "stable, deliberate" side we're building toward)

Three preview paper tenants, all mirroring swisstony on the same percentile + max-bet so the only variable is the sizing kind. Diff between any two = the policy delta.

| ROLE                   | TENANT                                                                           | POLICY                                                   | PURPOSE                                                                    | EXPECTED OUTCOME                                                                           |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `swiss-tps-control`    | reuse `fb8f65d5` (exists; pin from `auto` → explicit `target_percentile_scaled`) | `target_percentile_scaled` p80 / $15                     | baseline — what production runs today                                      | mirrors derek's prod wallet within `paper-twin-diff` tolerance                             |
| `swiss-gap-experiment` | NEW                                                                              | `position_gap` (default `target_scale = 1e-4`) p80 / $15 | tests D2 phase 2 against the control on real target activity               | minority-side delta materially lower than control; primary-side delta comparable or better |
| `swiss-minbet-floor`   | NEW                                                                              | `min_bet` $5                                             | sanity floor — should under-mirror everything, marks the lower-bound shape | tiny positions on every fill regardless of target shape; never beats the baseline          |

`paper-twin-diff.ts` (shipped via PR #93 once it lands) reports each tenant against the prod control. The matrix above is what the diff tool expects to compare.

## Constraints

What blocks driving the preview matrix from 1 tenant to the 3-row target state:

- **No proof that `paperEnforced=true` actually skips wallet-grants enumeration in preview.** Candidate-a evidence shows 4 active swisstony tenants with `0 active_conns / 0 active_grants` and `0 decisions / 0 fills`. If preview behaves the same, registering new tenants with the trust-twin recipe will produce inert rows — same as the candidate-a orphans. Must confirm preview's `dbTargetSource.listAllActive` path before populating the matrix.
- **No agent-API key issuance loop documented for paper tenants.** The `POLY_PREVIEW_TRUST_TWIN_*` env vars exist because someone went through the `/contribute-to-cogni` register flow once. Repeating that for two more tenants is not yet a standard recipe — needs either a script or a charter pointer.
- **No standing observation surface for the matrix.** `/validate-candidate` is per-PR. `paper-twin-diff.ts` (PR #93) is per-invocation. Continuous matrix observation (the thing this charter wants) requires either a scheduled `/loop` job or a Grafana dashboard backed by `poly_copy_trade_decisions` filtered by tenant. Neither exists yet.
- **v0 capital cap of $15 per trade on preview tenants.** Hard cap from `mirror_max_usdc_per_trade`. The matrix measures _delta from target_, not P/L magnitude — these will diverge at v1 cap loosening, by design.

## Cleanup policy

A tenant is a **cleanup candidate** when ALL of:

- It has no row in this charter's current matrix.
- Its `(decisions, fills, active wallet connections, active wallet grants)` are all zero or have been stale ≥7 days.
- The owner is `none` (no env key in `.env.cogni` or any agent's saved credential set).

**Cleanup action:** soft-delete via `PATCH/DELETE /api/v1/poly/copy-trade/targets/<id>` (or direct `UPDATE poly_copy_trade_targets SET disabled_at = now() WHERE id = …`). NEVER hard-delete — the row may still be referenced by ledger entries, attribution rows, or future audit needs. Soft-delete is reversible; hard-delete loses provenance.

**Cleanup cadence:** opportunistic + before every new matrix row is added (so the matrix stays a true picture). Not a scheduled job in v0.

**Caveat — candidate-a is freely mutable by design.** Cleanup on candidate-a is a hygiene loop, not a correctness gate. On preview, the same policy is stricter: any tenant without a charter row is suspect because preview is supposed to be deliberate.

## Open items

- **2026-05-17:** preview has only 1 paper tenant. Need to register 2 more (`swiss-gap-experiment`, `swiss-minbet-floor`) and capture their API keys in `.env.cogni`. Blocked on confirming `dbTargetSource.paperEnforced=true` actually skips the wallet_connections/grants joins on preview (candidate-a evidence suggests this is broken — see "Activity" column showing 0 active conns for tenants the mirror is supposedly running).
- **2026-05-17:** 3 orphan swisstony tenants on candidate-a (`20fdb57a`, `acd63233`, `809e37f7`) — 0 activity, 0 owner, 0 grants. Soft-delete them in the next housekeeping pass; preserve ledger history.
- **TBD:** branch `/validate-candidate` into `/validate-paper-matrix` — a recurring observation that enumerates this matrix's preview rows + queries Loki + the diff tool per row. Scheduled (probably `/loop` daily), not per-PR.
- **TBD:** if PAPER_ENFORCE_MODE=paper genuinely bypasses the wallet_grants join, document it as the matrix's load-bearing invariant: "preview paper tenants do NOT need real Privy wallets — having a target row is sufficient activation." If that's NOT true, the matrix can't be built without onboarding real (or fake) wallets, which is a much bigger ask.

## Pointers

- `chr.poly-copy-delta` — the failure-mode taxonomy this matrix runs experiments against
- `docs/spec/poly-copy-trade-position-mirror.md` — the D2 phase plan whose phase-2 done condition lives in this matrix
- `.claude/skills/validate-candidate/SKILL.md` — per-PR exercise; this matrix is the cross-PR continuous version
- `.claude/skills/paper-trade-diff-analysis/SKILL.md` — the diff tool that consumes matrix rows
- `nodes/poly/scripts/paper-twin-diff.ts` — implementation
- `.env.cogni` — current per-env API keys (POLY*PROD_TENANT*_, POLY*PREVIEW_TRUST_TWIN*_)
- `nodes/poly/app/src/features/copy-trade/target-source.ts` — `dbTargetSource.listAllActive` (the gate that determines whether a tenant gets enumerated)
