---
id: chr.poly-algo-tenant-matrix
type: charter
title: "Poly Algo Testing Tenant Matrix"
state: Draft
summary: "Living matrix of the per-(env, tenant) paper-trading accounts we operate for algo iteration + observation. Tracks which sizing policy / target wallet / sizing knobs each tenant runs, what hypothesis it serves, and who owns it. Candidate-a is freely mutable (devs A/B at will); preview is the stable layer where only thought-through policy changes land. Companion to chr.poly-copy-delta (the failure-mode taxonomy this matrix runs experiments against)."
created: 2026-05-17
updated: 2026-05-28
last_evaluated: 2026-05-28
evaluations: 4
---

# Poly Algo Testing Tenant Matrix

> **Status: DRAFT.** Matrix below is a true snapshot at `updated:` date. Re-run the audit query in `## Stability gates` before relying on it — every `POST /api/v1/poly/copy-trade/targets`, `DELETE`, or migration touching `poly_copy_trade_targets` invalidates it.

## Goal

Stand up and maintain a deliberate set of paper-trading tenants across `candidate-a` and `preview` so **every algo change can be A/B'd against a baseline before it touches production**. Each row is a (env, tenant, target wallet, sizing policy, sizing knobs) tuple with a stated hypothesis. When a delta-minimizer report or charter-D-class finding implies an algo change, the matrix is the substrate that proves it worked.

## Trust twin vs budget modeler — definitions (read first)

These two terms are persistently conflated in older code/env-var names. The matrix tool aliases display labels to enforce the correct usage:

- **Trust twin** — a paper tenant whose `(sizing_policy_kind, mirror_max_usdc_per_trade, target_range_max_usdc, mirror_max_alloc_per_condition_usdc, mirror_filter_percentile)` is a 1-to-1 match with a prod LIVE row. Single purpose: hold the algorithm constant and test whether the **paper sidecar produces the same fills as the real CLOB** when fed identical decisions. Currently **none exists** because prod has 0 active target rows (see Production table below). Provision one only when prod resumes trading.
- **Budget modeler** — a paper tenant whose sizing knobs are tuned to model the **target wallet's book scale** under a chosen policy (e.g. `position_gap` with `target_range_max_usdc` matching swisstony's typical position size). Tells you whether the policy is correctly sized for that wallet; does NOT test paper-vs-live fidelity. The env block `POLY_PREVIEW_TENANT_SWISSTONY_TRUST_TWIN_*` is historically a budget modeler — its env-var name is a misnomer that propagated. Tool aliases the display role to `SWISSTONY_BUDGET_MODELER`; env-block rename is a follow-up.
- **Policy variant** — every other paper tenant. Different policy or knobs vs the control; useful for ranking ("which policy comes closest to the target's behavior?") but never a fidelity test.

## How to use this charter

- **Proposing an algo change**: identify the control row, propose which row(s) the change should land on, state the observation that closes the loop.
- **Closing a delta-minimizer or fill-rate incident**: link the proof tape to the matrix row whose observation surfaced the signal.
- **Adding a new tenant**: give it a row here with `purpose`, `policy`, `knobs`, `env_key`, `cleanup_when`. Tenants without a row are throwaway and subject to consolidation.

## Discipline by environment

| ENV                                      | DISCIPLINE                                                                                | WHO MUTATES                | WHAT FLOWS                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| `candidate-a` (`poly-test.cognidao.org`) | freely mutable — devs flip policies, register/delete tenants at will                      | any agent or human dev     | every code change in any open PR after `candidate-flight` |
| `preview` (`poly-preview.cognidao.org`)  | stable, deliberate — policy changes require a charter update first                        | curated set of agents only | code merged to main; promoted via preview-flight pipeline |
| `production` (`poly.cognidao.org`)       | append-only history — never A/B'd; lives behind charter `chr.poly-copy-delta` proof gates | derek's real wallet only   | code that survived ≥1 preview matrix cycle                |

**Why split:** candidate-a answers "did the code execute as expected?" (per-PR `/validate-candidate`). Preview answers "did the algo behave as expected over hours/days of real target activity?" (cross-PR, accumulating). Mixing collapses both signals.

## Audit method

Matrix below is built from `poly_copy_trade_targets` joined to a `poly_copy_trade_decisions` 24h aggregate, both grouped by `billing_account_id`. The ledger's `target_id` column is `uuidv5(target_wallet)` — shared across tenants on the same wallet, **not** the row PK. Earlier drafts joined on the PK and incorrectly concluded ~4 active tenants were inert; they were not. Current audit uses `(billing_account_id, target_wallet)` pairing — confirmed against ledger directly via the matrix tool.

**Material events since prior audit (2026-05-19):**

- **2026-05-24 19:00 UTC** — preview paper sidecar fill-rate cliff (40% → 0.1% in 1h, lasted 70+h). Code unchanged (`f620cc8c` ran continuously). Cause unproven; theories in `nodes/poly/research/preview-data-health-handoff-2026-05-28.md`.
- **2026-05-27 17:59 UTC** — preview pod restart (concurrent with task.5014 / PR #141 deploy) restored ~50% fill-rate. Migration 0057 simultaneously **force-disabled every active `position_gap` row** because task.5014 dropped `mirror_capital_alloc_usdc` and added `target_range_max_usdc` + `mirror_max_alloc_per_condition_usdc` under a CHECK that legacy rows couldn't satisfy.

## Projects

**Current state as of 2026-05-28.**

### Production

| TENANT | TARGET WALLET | ALGO POLICY | KNOBS | OWNER ENV-KEY                   | STATE | NOTE                                                                                                      |
| ------ | ------------- | ----------- | ----- | ------------------------------- | ----- | --------------------------------------------------------------------------------------------------------- |
| —      | —             | —           | —     | `POLY_PROD_TENANT_LIVE_*` (set) | NONE  | **Zero active target rows.** Last decision 2026-05-12. No fidelity twin provisionable until prod resumes. |

### Candidate-a — freely mutable (active rows only)

| TENANT (short) | TARGET WALLET | ALGO POLICY                             | KNOBS     | OWNER ENV-KEY                          | DECISIONS / PLACED (24h) | DISPOSITION                                                                        |
| -------------- | ------------- | --------------------------------------- | --------- | -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `1890787d`     | swisstony     | `target_percentile_scaled` (via `auto`) | p80 / $15 | `POLY_CANDIDATE_A_TENANT_VALIDATION_*` | 16,258 / 136             | 🟢 control — matches preview TRUST_TWIN. Drives `/validate-candidate` exercises.   |
| `20fdb57a`     | swisstony     | `target_percentile_scaled` (via `auto`) | p75 / $5  | **orphan**                             | 16,257 / 167             | 🟡 consolidation candidate — three identical p75/$5 rows produce duplicate signal. |
| `acd63233`     | swisstony     | `target_percentile_scaled` (via `auto`) | p75 / $5  | **orphan**                             | 16,257 / 168             | 🟡 consolidation candidate (same).                                                 |
| `809e37f7`     | swisstony     | `target_percentile_scaled` (via `auto`) | p75 / $5  | **orphan**                             | 16,258 / 166             | 🟡 consolidation candidate (same).                                                 |

**Candidate-a disabled rows (recent + relevant):** 5 disabled — 2 ancient `auto` (fba44c50, 9ca836cf), 1 RN1 position_gap (f472b6ad), 3 position_gap on `d66032aa` (last two carry the new task.5014 knobs `range_max=10000/15000`, `max_per_cond=20/25` — failed experiments left in soft-deleted state).

### Preview — stable, deliberate (active rows only)

| TENANT (short) | TARGET WALLET | ALGO POLICY                             | KNOBS      | OWNER ENV-KEY                      | DECISIONS / PLACED (24h) | DISPOSITION                                                                                                                                  |
| -------------- | ------------- | --------------------------------------- | ---------- | ---------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `eae447b1`     | swisstony     | `target_percentile_scaled` (via `auto`) | p80 / $15  | `POLY_PREVIEW_TENANT_TRUST_TWIN_*` | 8,969 / 64               | 🟡 **HARD LOCKED control** — matches candidate-a `1890787d`. Env-block name is "TRUST_TWIN" but it is NOT a fidelity twin (see top of file). |
| `fb8f65d5`     | swisstony     | `target_percentile_scaled` (via `auto`) | p80 / $100 | **orphan**                         | 8,969 / 157              | 🟡 large-cap auto variant — tests whether lifting the per-trade cap from $15 → $100 changes signal. Mutable only via Grafana SA SQL.         |

**Preview disabled rows (force-disabled 2026-05-27 17:59 UTC by migration 0057):**

| TENANT (short) | OLD POLICY                          | OLD KNOBS   | OWNER ENV-KEY                                | REVIVAL PATH                                                                               |
| -------------- | ----------------------------------- | ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `0e16cf1a`     | `position_gap` (no task.5014 knobs) | p80 / max15 | `POLY_PREVIEW_TENANT_GAP_*`                  | POST new row with `target_range_max_usdc` + `mirror_max_alloc_per_condition_usdc` set.     |
| `b0ca1bce`     | `position_gap` (no task.5014 knobs) | p75 / max5  | `POLY_PREVIEW_TENANT_SWISSTONY_TRUST_TWIN_*` | Same. **This is the budget modeler**, not a trust twin — see definitions.                  |
| `376c594c`     | `position_gap` (no task.5014 knobs) | p80 / max15 | **orphan (no env block)**                    | Same, but no agent API key available from `.env.cogni` — needs env-block wire-up first.    |
| `13c81ec7`     | `position_gap` (no task.5014 knobs) | p75 / max5  | none                                         | Ancient (disabled 2026-05-19), pre-task.5014. Do not revive — replaced by `b0ca1bce` slot. |

The `disabled_at IS NULL` WHERE clause on the PATCH endpoint means revival is via **POST a fresh row** (preserves attribution history). Per the task.5014 server validator, position_gap POSTs require both new knobs or 400.

## Target preview matrix — proposed next state

Three preview rows on swisstony, identical `mirror_max_alloc_per_condition_usdc=15` cap so the variable is the saturation range. Diff across rows = sensitivity to the new task.5014 range knob.

| ROLE                        | TENANT (POST-new)                                   | POLICY         | KNOBS                                                             | PURPOSE                                                                                                                |
| --------------------------- | --------------------------------------------------- | -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `swiss-tps-control`         | reuse `eae447b1`                                    | `auto` (= tps) | p80 / max15                                                       | baseline — what the surviving preview tenant runs today.                                                               |
| `swiss-gap-tight`           | new on `POLY_PREVIEW_TENANT_GAP_*`                  | `position_gap` | `target_range_max_usdc=10000`, `max_alloc_per_condition_usdc=15`  | tight saturation — relative=1.0 once swisstony's position in a market crosses $10k.                                    |
| `swiss-budget-modeler-500k` | new on `POLY_PREVIEW_TENANT_SWISSTONY_TRUST_TWIN_*` | `position_gap` | `target_range_max_usdc=500000`, `max_alloc_per_condition_usdc=15` | loose saturation — matches swisstony's book-scale (positions can run into hundreds of $k); the budget-modeler concept. |

`376c594c` slot omitted from the new matrix unless someone wires an env block for it.

When prod resumes trading, a true **trust twin** row gets added separately with `(sizing_policy_kind, mirror_max_usdc_per_trade, target_range_max_usdc, mirror_max_alloc_per_condition_usdc, mirror_filter_percentile)` matching prod LIVE byte-for-byte. The matrix tool's Q1 picks it automatically via exact-match scan.

## Constraints

- **Preview cliff cause unproven.** The 2026-05-24 fill-rate collapse has 4 ranked theories (handoff 2026-05-28), none validated; old pod is gone. If it recurs, snapshot pm_trader SQLite + fill_loop heartbeats BEFORE restart per the handoff §1 recipe.
- **No `.env.cogni.example`.** No checked-in template of the per-tenant key shape. Future agents can't discover what keys the matrix expects.
- **No standard recipe for issuing agent API keys to new paper tenants.** Existing env blocks were registered ad-hoc.
- **No standing observation surface for the matrix.** `/validate-candidate` is per-PR. `tenant-matrix-evaluator.ts` is per-invocation. Continuous observation needs either a scheduled `/loop` or a Grafana dashboard backed by `poly_copy_trade_decisions` filtered by `(env, billing_account_id)`. Neither exists yet.
- **Three duplicate swisstony rows on candidate-a** (`20fdb57a`, `acd63233`, `809e37f7`) produce nearly identical 16k-decision streams. Consolidation to one canonical row would cut noise; needs soft-delete.

## Stability gates

Two gates. Both about whether this charter can be trusted as governance.

- [x] Audit query re-run independently — counts in the Projects tables match (re-issued via `tenant-matrix-evaluator.ts` 2026-05-28T19-43 + direct Grafana DS queries).
- [ ] `.env.cogni.example` checked in, documenting every `POLY_<ENV>_<ROLE>_*` key the matrix references (shape, redacted values).

### Audit query

```sql
-- Per env (candidate-a, preview), via scripts/grafana-postgres-query.sh.
WITH d AS (
  SELECT billing_account_id, COUNT(*) AS decisions,
    COUNT(*) FILTER (WHERE outcome='placed') AS placed,
    MAX(decided_at) AS latest
  FROM poly_copy_trade_decisions
  WHERE decided_at > NOW() - INTERVAL '24 hours'
  GROUP BY 1
)
SELECT substr(t.billing_account_id, 1, 8) AS billing,
  t.sizing_policy_kind AS policy,
  t.mirror_max_usdc_per_trade AS max_trade,
  t.target_range_max_usdc AS range_max,
  t.mirror_max_alloc_per_condition_usdc AS max_per_cond,
  t.mirror_filter_percentile AS pct,
  CASE WHEN t.disabled_at IS NULL THEN 'ACTIVE' ELSE 'disabled' END AS state,
  COALESCE(d.decisions, 0) AS decisions_24h,
  COALESCE(d.placed, 0) AS placed_24h
FROM poly_copy_trade_targets t
LEFT JOIN d ON d.billing_account_id = t.billing_account_id
ORDER BY t.disabled_at NULLS FIRST, t.billing_account_id;
```

## Cleanup / consolidation policy

A tenant is a **consolidation candidate** when ALL of:

- No row in this charter's current matrix.
- Another tenant on the same env runs the same `(target_wallet, sizing_policy_kind, knobs)` config.
- Owner is `none` (no env key in `.env.cogni`).

**Action:** soft-delete via API DELETE (if you have a session) or direct `UPDATE … SET disabled_at = NOW() WHERE id = …`. NEVER hard-delete — ledger rows reference `(billing_account_id, target_id)` and lose provenance on removal.

**Cadence:** opportunistic + before every new matrix row is added. Not scheduled in v0.

**Caveat:** candidate-a consolidation is hygiene, not correctness. On preview, stricter: any active tenant without a charter row is suspect.

## Open items

- **2026-05-28 (open):** Wire the proposed preview matrix (`swiss-gap-tight` + `swiss-budget-modeler-500k`) via POST + the task.5014 knobs. Pending user go-ahead on values.
- **2026-05-28 (open):** Rename env block `POLY_PREVIEW_TENANT_SWISSTONY_TRUST_TWIN_*` → `POLY_PREVIEW_TENANT_SWISSTONY_BUDGET_MODELER_*` in `.env.cogni`. Touches: matrix tool's alias map, this charter, the handoff doc. Independent of the POSTs above (the new row inherits whatever billing_account_id the env block carries, regardless of the var name).
- **2026-05-28 (open):** Sidecar instrumentation PR per `preview-data-health-handoff-2026-05-28.md` §2 — `sqlite_pending_count` in heartbeat, `_maker_fill_last_scan` cursor lag log, unconditional cursor bound. Three small additions to `nodes/poly/sidecars/paper-trader/server.py` + `vendor/pm_trader/.../engine.py`. Defensive obs for the next cliff; not a blocker.
- **2026-05-17 → 2026-05-28 (still open):** Consolidate the 3 duplicate swisstony p75/$5 candidate-a rows. Hold pending the position_gap experiment producing useful diff.
- **2026-05-17:** Draft `.env.cogni.example`. Stability gate #2.
- **TBD:** Branch `/validate-candidate` into `/validate-paper-matrix` — recurring observation enumerating preview rows + Loki + diff tool per row.
- **TBD:** Grafana dashboard for matrix observation — one panel per row, decisions/placed/skip-reasons over time, side-by-side.

## Pointers

- `chr.poly-copy-delta` — failure-mode taxonomy this matrix runs experiments against
- `docs/spec/poly-copy-trade-execution.md` — D2 phase plan whose phase-2 done condition lives in this matrix
- `nodes/poly/research/preview-data-health-handoff-2026-05-28.md` — current open thread on the cliff cause + next-steps
- `nodes/poly/scripts/tenant-matrix-evaluator.ts` — the cross-policy A/B tool that consumes this matrix
- `.claude/skills/tenant-matrix-evaluator/SKILL.md` — invocation contract + the trust-twin vs budget-modeler definitions enforced by display alias
- `.claude/skills/validate-candidate/SKILL.md` — per-PR exercise; this matrix is the cross-PR continuous version
- `.claude/skills/paper-trade-diff-analysis/SKILL.md` — diff tool that consumes matrix rows
- `.env.cogni` — per-env API keys (`POLY_<ENV>_TENANT_<ROLE>_*`); MUST be mirrored by `.env.cogni.example`
- `nodes/poly/app/src/features/copy-trade/plan-mirror.ts:249-250` — position_gap sizing formula (`relative = min(delta/target_range_max_usdc, 1)`, `desired_usdc = max_alloc_per_condition_usdc × relative`)
- `nodes/poly/app/src/app/api/v1/poly/copy-trade/targets/route.ts` — POST (creates active row; partial-unique against active only) and `[id]/route.ts` PATCH (active-only, can't revive)
- `nodes/poly/app/src/adapters/server/db/migrations/0057_*.sql` — task.5014 schema rewrite; force-disables legacy position_gap rows
