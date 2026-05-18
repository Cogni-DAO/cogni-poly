---
name: tenant-matrix-evaluator
description: "Cross-policy A/B evaluator across every per-(env, tenant) paper-trading account in chr.poly-algo-tenant-matrix. Runs against one target wallet over a window, produces an HTML report with bar-chart graphs per metric + an LLM-authored top finding. Use when: 'evaluate the matrix', 'is position_gap beating tps?', 'tenant A/B for swisstony', '/tenant-matrix-evaluator', 'rank our policies on real target activity'. Sibling to /delta-minimizer (one market) and /paper-trade-diff-analysis (one twin × one prod)."
---

# Tenant Matrix Evaluator

> Zoom level: cross-policy A/B across every charter-listed tenant on ONE target wallet. **Tool emits graphs; agent emits ONE finding.**

## Required reading

- [`docs/spec/poly-tenant-matrix-evaluator.md`](../../../docs/spec/poly-tenant-matrix-evaluator.md) — spec, invariants, done condition
- [`work/charters/POLY_ALGO_TENANT_MATRIX.md`](../../../work/charters/POLY_ALGO_TENANT_MATRIX.md) — the matrix this tool consumes
- [`.claude/skills/delta-minimizer/SKILL.md`](../delta-minimizer/SKILL.md) — finding discipline (one primary, % confidence, file:line cite, charter class)
- [`work/charters/POLY_COPY_DELTA.md`](../../../work/charters/POLY_COPY_DELTA.md) — D-class taxonomy used in findings

## Outcome contract

A run is complete when ALL of these are true:

1. `report.html` rendered with one bar chart per axis (decisions, placed, placement-rate, intent $, realized $, open positions, markets touched) and an A/B Δ-table.
2. `bundle.json` covers every controllable tenant in `.env.cogni` (no `half-block detected` errors at startup).
3. Low-sample rows (decisions < 50) are flagged 🟡 in the report.
4. The `<!-- TAKEAWAY:START -->` block carries ONE primary finding (max two) with `% confidence` + a single Pareto next-fix line.
5. `findings.json` mirrors the TAKEAWAY: `primary_class`, `primary_confidence` (0–1), `primary_one_liner`, `authored_at`.
6. Zero `POST/PATCH/DELETE` lines against `poly-*.cognidao.org` in stderr — the tool is GET-only by construction; if anything else appears, that's a regression to file.

## Workflow

```bash
# .env.cogni must be sourced (or symlinked into the worktree).
pnpm tsx nodes/poly/scripts/tenant-matrix-evaluator.ts \
  0x204f72f35326db932158cba6adff0b9a1da95e14 \
  [--since 2026-05-17T00:00:00Z] [--until 2026-05-18T00:00:00Z] \
  [--control POLY_PREVIEW_TENANT_TRUST_TWIN] [--out path]
```

Default control: `POLY_PREVIEW_TENANT_TRUST_TWIN`. Default window: last 24h. Output dir: `nodes/poly/research/tenant-matrix/<iso>/`.

1. **Run the tool.** It auto-discovers tenants from `POLY_<ENV>_TENANT_<ROLE>_*` env vars; fails fast on half-blocks.
2. **Read the bars first.** Each chart is one axis across all tenants; control is amber. If sample size is too small to claim anything, that IS the finding — say so.
3. **Cross-reference code BEFORE claiming.** Skip-reason or sizing claim → cite `nodes/poly/app/src/features/copy-trade/plan-mirror.ts:<line>`. Volume / mode mismatch claim → cite `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts` or `target-source.ts`. No file:line = not done.
4. **Fill the TAKEAWAY + findings.json.** One primary finding, % confidence, charter D-class (or `null` with one-line reason), Pareto next-fix.
5. **Commit the timestamped dir.** History matters.

## What the tool does (so you don't redo it)

- Globs `process.env` for `POLY_<ENV>_TENANT_<ROLE>_{API_KEY,BILLING_ACCOUNT_ID}` pairs.
- Per tenant: `GET /api/v1/poly/research/copy-trade-pnl` → filtered to target_wallet client-side → fills aggregate.
- Per tenant: Grafana Postgres SELECT on `poly_copy_trade_decisions` filtered by `(billing_account_id, target_id, window)` → outcome + skip-reason aggregate.
- A/B compare each non-control tenant against the control on 6 axes.
- Renders inline-SVG bar charts (no JS), A/B Δ-table, TAKEAWAY stub, bundle, findings stub.

## What the tool does NOT do (yet)

- **VWAP, realized PnL, winrate** — require `poly_market_outcomes` + `poly_trader_position_snapshots` joins; v0-deferred. Bundle carries `null` for those metrics; finding MUST NOT claim VWAP-delta until the joins land.
- **Per-tenant timeline chart** — also v0-deferred. Bars only.
- **Charter mutation** — strictly read-only. If your finding implies a charter edit, do it surgically per `/delta-minimizer`'s charter-edit rules.

## Finding discipline (mirrors /delta-minimizer)

- **One primary finding.** Two max if you can prove different root causes.
- **% confidence mandatory.** ≥85% needs code-path read + decision-count verification. Don't write findings under 60%.
- **Cite file:line** for any algorithmic claim.
- **Sample-size honesty.** Decisions < 50 or resolved markets < 3 → 🟡; finding must acknowledge the floor. "Insufficient sample, re-run after N hours" is a valid finding.
- **Charter class.** Pick from `work/charters/POLY_COPY_DELTA.md` D1–D8, or set `primary_class: null` with reason. Do not invent a new D-row without explicit user approval in-turn.

## Meta loop — improving the matrix itself

Each invocation is also an opportunity to ask "is the matrix or the tool the bottleneck?" Capture these in the finding's secondary slot or as a follow-up `bug.*` / `task.*` via the poly work-items API:

- **Data-analysis efficiency:** decisions query slow / OOM-risk over wide windows → file a `data-research`-skill task to migrate to SQL-only aggregation per the bug.5012 pattern. Don't band-aid with `LIMIT`.
- **Algorithm tuning:** if the matrix surfaces a stable signal (e.g. swiss-gap consistently under-fills minority side by X%), the next move is a planner change in `plan-mirror.ts` or `copy-trade-mirror.job.ts` — propose the smallest concrete edit, link the report.
- **Matrix gaps:** charter lists a row but the env has no key, or the env has a key but the charter has no row → file a charter follow-up. Do not paper over with hard-coded fallbacks.

## Pointers

- Tool: `nodes/poly/scripts/tenant-matrix-evaluator.ts`
- Spec: `docs/spec/poly-tenant-matrix-evaluator.md`
- Charter: `work/charters/POLY_ALGO_TENANT_MATRIX.md`
- Output dir: `nodes/poly/research/tenant-matrix/<iso>/`
- Sibling skills: [`/delta-minimizer`](../delta-minimizer/SKILL.md), [`/paper-trade-diff-analysis`](../paper-trade-diff-analysis/SKILL.md)
- Planner cheat-sheet: `nodes/poly/app/src/features/copy-trade/plan-mirror.ts`
- Postgres helper: `scripts/grafana-postgres-query.sh` (matches the tool's per-env datasource UID convention `cogni-<env>-poly-postgres`)
