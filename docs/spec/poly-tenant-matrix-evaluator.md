---
id: poly-tenant-matrix-evaluator
type: spec
title: "Poly Tenant Matrix Evaluator"
status: draft
spec_state: draft
trust: draft
summary: "Cross-policy A/B evaluator for Polymarket copy-trade tenants. One target wallet, one window, every charter-listed paper tenant ranked by aggregate distance to the target's real on-chain behavior; prod-twin fidelity Δ gates all PnL claims. Read-only; emits report.html + bundle.json + findings.json stub."
read_when: Adding/changing a sizing policy, comparing paper-trading variants against the real target, debugging an empty matrix run (0 buckets), or wiring a new POLY_<env>_TENANT_<role>_* env block.
implements: chr.poly-algo-tenant-matrix
owner: derekg1729
created: 2026-05-26
---

# Poly Tenant Matrix Evaluator — Spec

> Cross-policy A/B evaluator. Reads-only. One tool invocation = one HTML
> report + bundle + LLM finding stub, comparing every charter-listed paper
> tenant against a single target wallet's true on-chain behavior.

## Goal

Given a target wallet (canonical: `swisstony`) and a window, the evaluator
answers two questions in one shot:

1. **Is the paper-trading twin a faithful copy of the prod live algorithm?**
   On shared on-chain fills, is the paper mirror's per-fill PnL within ±5% of
   the live mirror's? If yes (🟢), every other comparison in the report can
   trust paper-side numbers. If no, paper trading is NOT a trustworthy A/B
   substrate and we stop promoting policy variants out of preview.

2. **Which paper policy variant hugs the target wallet's actual behavior the
   tightest?** Rank every non-prod-live tenant by aggregate distance to the
   target on four axes (realized-PnL %, placement-rate, intent-USDC ratio,
   markets-touched ratio). Closest to zero → leaderboard winner → promotion
   candidate (gated by Q1).

## Non-Goals

- **Charter mutation.** This is a read-only observation surface. Findings that
  imply a matrix-charter edit must be filed as a follow-up, not stamped in by
  the tool. Same for `poly_copy_trade_targets` edits — those go through the
  copy-trade API or a charter-approved DB migration.
- **Re-implementing the wallet-PnL aggregator.** The target-wallet realized
  PnL math is the same shape as `realized-pnl-service.ts`; the tool inlines
  the SQL only because it queries via Grafana (no DB driver in scope here).
- **Live execution claims from paper numbers.** Paper-side PnL is biased per
  `poly-paper-trading-shortcomings.md`. The leaderboard ranks _relative_
  closeness to the target, not absolute live profitability. Promotion to live
  needs `prod_twin_fidelity_class = green` first.
- **Backfilling `poly_trader_fills`.** When the tool reports 0 target buckets,
  the cause is a Grafana DS misconfiguration. The fix is in DS wiring, not in
  wallet-watch. The verbatim fail-fast message names this out loud.

## Invariants

- **`TARGET_IS_PRIMARY_CONTROL`**: the default control axis is the target
  wallet's real on-chain activity, not an arbitrary paper tenant. A paper
  tenant becomes a secondary control only when `--control-tenant-role` is set,
  in which case a per-axis A/B Δ-table renders alongside the target-as-control
  ranking. Renaming a tenant to `TRUST_TWIN` does not promote it to the
  primary control — only `--control-tenant-role` does that, and even then the
  distance-to-target leaderboard remains the primary ranking surface.

- **`TWIN_FIDELITY_IS_FIRST_CLASS`**: every report carries a `prod-twin
fidelity Δ` block above the takeaway. The block classifies 🟢 (shared > 50
  AND PnL Δ within ±5%) · 🟡 (within ±20%) · 🔴 (otherwise) · ⚪ (no
  POLY_PROD_TENANT_TRUST_TWIN configured). The block is loud and never
  hidden in an appendix — it's the gate on every other claim the LLM can
  make in the takeaway.

- **`TARGET_DS_MUST_RESOLVE`**: the target wallet's `poly_trader_fills`
  rows are queried against each unique env DS discovered from tenants
  (`cogni-<env>-poly-postgres`), and the env with the most non-zero hourly
  buckets wins. If every env returns 0 buckets, the tool fails fast with:

  ```
  ::error::target-wallet has no fills in DS=<uid> for window;
  check DS config — wallet-watch is NOT the suspect, the data is in
  poly_trader_fills in every env's poly DB.
  ```

  Wallet-watch is intentionally exonerated by the message because the
  2026-05-26 incident's first instinct was to file a wallet-watch backfill
  task that didn't need to exist. Every env's wallet-watch is fine. The
  cause is a Grafana DS misconfiguration (e.g. UID points at the wrong DB),
  and the message names that suspect out loud.

- **`ENV_GAPS_WARN_NEVER_BLOCK`**: charter-active tenants present in
  `poly_copy_trade_targets WHERE disabled_at IS NULL` for the target wallet
  but absent from `POLY_<env>_TENANT_<role>_*` env blocks emit a
  `::warning::matrix gap: ...` line and are listed in `env_gap_warnings`
  on bundle.json + findings.json. They do not block the run. The fix is a
  charter follow-up + new env-block — not a hidden fallback.

- **`EVALUATOR_IS_READ_ONLY`**: every SQL starts with `SELECT` or `WITH`.
  Zero `POST/PATCH/DELETE` against any `poly-*.cognidao.org` endpoint. If
  any non-read SQL slips into the tool, that's a regression to file.

- **`BUNDLE_IS_SOURCE_OF_TRUTH`**: every cell the HTML renders is derivable
  from `bundle.json`. The HTML is a view; the bundle is the data.

- **`FINDING_IS_LLM_AUTHORED`**: the tool writes a stub `findings.json` with
  null primary fields. The structured Δ summary lines above the takeaway are
  machine-derived (closest-to-target, prod-twin fidelity, sample-size floor).
  The bold one-liner inside `<!-- TAKEAWAY:START --> ... <!-- TAKEAWAY:END
-->` is the LLM's job — one sentence, ≤20 words, % confidence + cause +
  next-fix optional postfix in muted text, file:line cite for any planner
  claim. The LLM mirrors the same primary one-liner into `findings.json`.

## Design

The tool is a single TypeScript script driven by Grafana service-account
queries — no DB driver, no node-app imports — so it can run from any worktree
with only `.env.cogni` sourced. The control axes invert the prior shape:

- **Tenant discovery from env.** `discoverTenants(process.env)` globs every
  `POLY_<env>_TENANT_<role>_{API_KEY,BILLING_ACCOUNT_ID}` pair, validates
  half-block pairs, and exits 2 on any partial. Sorted deterministic order
  drives both report layout and bundle iteration.

- **Target DS resolution (per-env probe).** Each unique `cogni-<env>-poly-postgres`
  DS the tenants discover is probed for hourly `poly_trader_fills` buckets in
  window; whichever has the most non-zero buckets wins. The hard-coded
  production-DS assumption is gone. Fail-fast on zero across all envs.

- **Target-side aggregates.** Four queries against the chosen DS:
  `fetchTargetHourlyVolume` (cumulative line chart),
  `fetchTargetMarketSet` (the bare conditionIds the target traded),
  `fetchTargetIntentUsdc` (total USDC for distance-ratio math),
  `fetchTargetRealizedPnl` (poly_market_outcomes join — the v0-deferred PnL).

- **Per-tenant aggregates.** For each discovered tenant, the same six queries
  the prior tool ran (fills agg, hourly buckets, decisions, realized-PnL,
  market-set, decision-list for fidelity). These remain SQL-side aggregations
  — no row-by-row hydration into V8 (`bug.5012` class avoidance).

- **Distance-to-target.** `distanceToTarget(metrics, target)` reduces each
  tenant to one aggregate distance on four axes (PnL %, placement rate,
  intent ratio, markets-touched ratio). The leaderboard sorts ascending.

- **Prod-twin fidelity Δ.** Per-fill `decisionFidelity(twin, live)` already
  existed in the prior tool but wasn't surfaced; the new `ProdTwinFidelity`
  layer combines that shared-fill count with the realized-PnL Δ between the
  prod-twin tenant (`POLY_PROD_TENANT_TRUST_TWIN`) and the prod-live tenant
  (`POLY_PROD_TENANT_LIVE`). `classifyProdTwinFidelity` chips it 🟢/🟡/🔴/⚪
  per the SKILL.md thresholds. When no prod-twin is configured, falls back to
  (`--control-tenant-role` ↔ prod-live).

- **Env-gap probe.** For each unique env DS, `fetchActiveTargetsInEnv`
  enumerates `poly_copy_trade_targets WHERE disabled_at IS NULL` and diffs
  against the discovered env blocks. Any active row whose billing_account_id
  isn't represented emits a `::warning::matrix gap` stderr line and lands in
  `env_gap_warnings[]`.

- **HTML report.** Three new surfaces above the prior Q1 + Q2 blocks:
  - Structured Δ summary block above `<!-- TAKEAWAY:START -->` — three
    machine-derived lines (closest-to-target, prod-twin fidelity,
    sample-size floor), plus env-gap callouts.
  - 🪞 Prod-twin fidelity Δ section (with classification chip) — the gate.
  - 🎯 Distance-to-target leaderboard chart (SVG horizontal bars).
    The legacy bar-chart helpers + Q1/Q2 + algo-table + decisions reference
    appendix all remain — the change is additive, not a rewrite.

- **Bundle + findings.** `bundle.json` is the single source of truth: every
  cell the HTML renders is derivable. `findings.json` is an LLM stub with
  four structured Δ-mirror fields pre-populated by the tool, plus the
  primary/secondary takeaway slots the LLM fills.

## Inputs

```
pnpm tsx nodes/poly/scripts/tenant-matrix-evaluator.ts <target-wallet> [flags]
```

Flags:

- `--since ISO` — window start (default: 24h ago)
- `--until ISO` — window end (default: now)
- `--control-tenant-role POLY_<ENV>_TENANT_<ROLE>` — opt-in paper-tenant
  control (back-compat); adds per-axis A/B Δ-table alongside target-as-
  control ranking
- `--target-ds-uid UID` — override the env DS used to read target-wallet
  fills (e.g. when you want to pin the report to a specific env's
  wallet-watch view)
- `--out PATH` — output dir (default:
  `nodes/poly/research/tenant-matrix/<iso>/`)

## Outputs

Under the output dir:

- `report.html` — primary deliverable. Structured Δ summary block above the
  takeaway, prod-twin fidelity Δ section, distance-to-target leaderboard
  chart, then the legacy Q1 + Q2 blocks + decisions reference.
- `bundle.json` — every cell the report renders, plus the raw per-tenant
  metrics, distances, env-gap warnings, sample-size warnings, fidelity, and
  target-DS resolution.
- `findings.json` — LLM stub with these structured Δ mirrors pre-populated:
  - `closest_to_target_role`, `closest_to_target_env_key_prefix`,
    `closest_to_target_distance`
  - `prod_twin_fidelity_pct`, `prod_twin_fidelity_class`,
    `prod_twin_fidelity_shared_fills`
  - `sample_floor_warnings[]`, `env_gap_warnings[]`, `target_ds_uid`
  - `primary_class`, `primary_confidence`, `primary_one_liner`,
    `pareto_next_fix`, `evidence.code_path`, `authored_at` — LLM fills

## Done condition

A run is complete when ALL of these hold:

1. Target-wallet fills appear in the bundle (>0 markets, plausible volume)
   OR the tool failed fast with the verbatim `::error::target-wallet has no
fills…` message. Silent-zero behavior is not allowed.

2. Both new Δ sections render in `report.html`:
   - 🪞 prod-twin fidelity Δ — with classification chip
   - 🎯 distance-to-target leaderboard — sorted ascending

3. `findings.json` carries the four new structured fields
   (`closest_to_target_role`, `closest_to_target_distance`,
   `prod_twin_fidelity_pct`, `prod_twin_fidelity_class`).

4. The `POLY_COPY_DELTA` D1–D8 taxonomy drives `primary_class`. No new
   D-row invented for matrix tooling.

5. `pnpm tsx nodes/poly/scripts/tenant-matrix-evaluator.ts --help` shows
   the new flags.

## Related

- Charter: `work/charters/POLY_ALGO_TENANT_MATRIX.md`
- Failure-mode taxonomy: `work/charters/POLY_COPY_DELTA.md`
- Tool: `nodes/poly/scripts/tenant-matrix-evaluator.ts`
- Skill: `.claude/skills/tenant-matrix-evaluator/SKILL.md`
- Sibling tools: `/delta-minimizer` (one market), `/paper-trade-diff-analysis`
  (one twin × one prod)
- Read-side that powers per-tenant aggregates:
  `nodes/poly/app/src/features/wallet-analysis/server/copy-trade-pnl-service.ts`
- Read-side that powers target-wallet PnL math:
  `nodes/poly/app/src/features/wallet-analysis/server/realized-pnl-service.ts`
