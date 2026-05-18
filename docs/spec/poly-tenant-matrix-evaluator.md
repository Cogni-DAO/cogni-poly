---
id: poly-tenant-matrix-evaluator
type: spec
title: "Poly Tenant Matrix Evaluator"
status: draft
spec_state: draft
trust: draft
summary: "Cross-policy A/B evaluator for the per-(env, tenant) paper-trading accounts enumerated in chr.poly-algo-tenant-matrix. Reads every POLY_<ENV>_TENANT_<ROLE>_* block from .env.cogni, queries each tenant's decisions + fills + positions over a window, computes per-tenant PnL / winrate / delta-from-target / placement rate, and produces a ranked A/B report with an LLM-authored top finding. Third sibling skill in the trio with /delta-minimizer (one market) and /paper-trade-diff-analysis (one twin × one prod trust signal)."
read_when: Implementing the `/tenant-matrix-evaluator` skill. Adding a new tenant or sizing policy to chr.poly-algo-tenant-matrix. Investigating whether `position_gap` is beating `target_percentile_scaled` (or the inverse) on real target activity.
implements: proj.poly-copy-trading
owner: derekg1729
created: 2026-05-18
verified: null
tags:
  [poly, polymarket, copy-trading, ab-testing, paper-trading, evaluator, draft]
---

# Poly Tenant Matrix Evaluator

> **Status: draft.** Spec only. No code yet. Implementer + validator follows the contribute-to-cogni lifecycle — handoff prompt at the bottom.

## Goal

**Success is when an agent or human can run `/tenant-matrix-evaluator <target-wallet> [--since <ts>] [--until <ts>]` and get a single HTML report ranking every tenant in our matrix (`chr.poly-algo-tenant-matrix`) by how well its sizing policy mirrored the target wallet over the window, with an LLM-authored top finding + % confidence that names which policy is winning and by how much.**

This is the cross-PR observation surface the charter named as missing. `/delta-minimizer` zooms in on one market; this skill zooms out across the whole matrix.

## Why this exists

D2 phase 2 (PR #92, `position_gap` variant) shipped without proving it actually beats `target_percentile_scaled` on real target activity. Today there are 2 live `position_gap` rows (one cand-a RN1 producing 0 placements, one preview swisstony just registered) but no continuous comparison surface. Per-PR `/validate-candidate` exercises individual API calls but not policy outcomes; `/paper-trade-diff-analysis` validates trust (paper tracks live) but on the SAME config. Without a cross-policy comparison, every algo change is shipped on intuition.

## Non-Goals

- Not a per-market investigator. That's `/delta-minimizer`.
- Not a paper-vs-live trust check. That's `/paper-trade-diff-analysis`.
- Does NOT mutate any tenant. Read-only over the decision/fill ledgers + Polymarket position state.
- Does NOT decide policy promotion — surfaces evidence so a human / charter update makes the call.
- Does NOT modify the matrix charter. New tenants land via the charter's existing flow; this skill just consumes whatever the charter currently lists.

## Inputs

### Tenant set: read from `.env.cogni`

Every `POLY_<ENV>_TENANT_<ROLE>_*` block in `.env.cogni` is a matrix row. The script discovers tenants by globbing env var names matching the pattern, NOT by hard-coded list. This keeps the charter and the evaluator in sync without an edit step. At minimum, each block carries:

- `POLY_<ENV>_TENANT_<ROLE>_API_KEY` — bearer for tenant-scoped API calls (read-only here)
- `POLY_<ENV>_TENANT_<ROLE>_BILLING_ACCOUNT_ID` — UUID for Grafana Postgres queries

Other fields (`USER_ID`, `TARGET_ID`, `TARGET_WALLET`, `CONFIG`) are advisory and ignored by this skill.

### CLI flags

| FLAG                           | SHAPE                                | DEFAULT                                           | PURPOSE                                                                                       |
| ------------------------------ | ------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `<target-wallet>` (positional) | `0x` + 40 hex                        | required                                          | Wallet to evaluate against; mirrors filter every tenant's decisions/fills to this target only |
| `--since`                      | ISO-8601                             | now − 24h                                         | start of evaluation window                                                                    |
| `--until`                      | ISO-8601                             | now                                               | end of evaluation window                                                                      |
| `--control`                    | tenant role name (e.g. `TRUST_TWIN`) | env-best (preview trust-twin)                     | which row is the A/B baseline                                                                 |
| `--out`                        | path                                 | `nodes/poly/research/tenant-matrix/<window-iso>/` | output dir                                                                                    |

### Env wiring (same as `paper-twin-diff.ts`)

- `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` — for the Postgres datasource queries
- `.env.cogni` — sourced ad-hoc (the existing scripts already do this via `readlink` of the symlink + `set -a; . $resolved; set +a`)

## Outputs

### `report.html` — the headline surface

Same shape as `nodes/poly/research/delta-minimizing/<...>/report.html`:

- Top finding block (`<!-- TAKEAWAY:START -->` → `END`): LLM-authored 1-line conclusion + % confidence + fix block. Stays empty until the agent fills it.
- KPI band: one cluster per tenant — PnL, winrate, delta-from-target.
- Matrix table: one row per tenant; columns include role, env, algo policy ref, algo policy config, decisions, placed, winrate, realized PnL, unrealized PnL, delta-from-target VWAP, placement rate.
- Per-tenant timeline chart: net position vs target's net position over the window, log-scale y axis (mirror the delta-minimizer chart shape).
- Decision-marker strip: skip-reasons over time per tenant.

### `bundle.json` — the structured AI surface

Top-level keys: `input`, `window`, `tenants`, `control`, `metrics`, `decisions` (filtered to the wallet + window), `placedOrders`, `target_position_snapshots`. Same convention as the delta-minimizer bundle.

### `findings.json` — the archival LLM finding

Schema mirrors `nodes/poly/research/delta-minimizing/<...>/findings.json`:

```json
{
  "primary_class": "matrix-ab",
  "primary_confidence": 0.0,
  "primary_one_liner": "",
  "secondary_class": null,
  "secondary_confidence": null,
  "secondary_one_liner": null,
  "authored_at": null
}
```

Stub written by the script; LLM fills it. NOT re-aggregated; archival only.

## Metrics per tenant

For each tenant × target_wallet × (since, until):

| METRIC                  | DEFINITION                                                     | DATA SOURCE                                                                                                        |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| decisions               | count(decisions)                                               | `poly_copy_trade_decisions` filtered by `billing_account_id` + `intent->>'target_wallet'` + `decided_at IN window` |
| placed                  | count(decisions WHERE outcome='placed')                        | same                                                                                                               |
| skipped                 | count(decisions WHERE outcome='skipped') GROUP BY reason       | same                                                                                                               |
| filled                  | count(fills WHERE status='filled')                             | `poly_copy_trade_fills` filtered by `billing_account_id` + `market_id` ∈ wallet's conditions                       |
| placement_rate          | placed / decisions                                             | derived                                                                                                            |
| our_vwap_per_token      | sum(filled_size_usdc) / sum(filled_size_shares) per token      | fills                                                                                                              |
| target_vwap_per_token   | from `poly_trader_position_snapshots` latest before window-end | trader snapshots (target's deterministic UUID)                                                                     |
| delta_vwap_per_token    | our_vwap − target_vwap, %                                      | derived                                                                                                            |
| net_position_value_usdc | sum(filled_size_usdc) − sum(redeemed_usdc) per token           | fills + redeem_jobs                                                                                                |
| realized_pnl_usdc       | summed over markets resolved in window: payout − cost_basis    | fills + `poly_market_outcomes`                                                                                     |
| unrealized_pnl_usdc     | for markets still open in window: current_value − cost_basis   | fills + last `poly_market_price_history`                                                                           |
| winrate                 | resolved_markets_we_won / resolved_markets_we_held             | fills + `poly_market_outcomes`                                                                                     |

**Important:** every per-tenant query SHOULD use the per-tenant API key bearer where possible (the agent-api route already filters by tenant via RLS) rather than raw BYPASSRLS reads. Falls back to `--env <env> --node poly` Grafana queries for ledger aggregation where the API doesn't expose the shape. See data-research skill — same disciplines apply.

## A/B comparison

For each non-control tenant, surface (control_metric, this_metric, delta, delta_pct):

| AXIS                        | CONTROL      | TREATMENT     | INTERPRETATION                                             |
| --------------------------- | ------------ | ------------- | ---------------------------------------------------------- |
| delta_vwap                  | trust-twin's | this tenant's | lower abs = closer to target VWAP = better                 |
| placement_rate              | trust-twin's | this tenant's | depends — too high = chasing, too low = missing the target |
| winrate                     | trust-twin's | this tenant's | higher = better (mod sample size noise)                    |
| realized*pnl_per*$\_capital | trust-twin's | this tenant's | normalized for fair comparison; higher = better            |

The top finding (LLM-authored) should name the strongest single signal across these axes and weigh it against sample size (decisions count + resolved-markets count in window).

## Design

Single TypeScript script + a companion SKILL.md. The script does the heavy lifting (env discovery, queries, metric calc, render); the skill governs how an agent invokes it and authors the finding. No new modules, ports, or runtime wiring. Pure offline tool that reads from already-existing data surfaces (`poly_copy_trade_decisions`, `poly_copy_trade_fills`, `poly_trader_position_snapshots`, `poly_market_outcomes`) via the Grafana Postgres datasource and per-tenant API keys.

## Implementation

### Script: `nodes/poly/scripts/tenant-matrix-evaluator.ts`

Extends `nodes/poly/scripts/paper-twin-diff.ts`. Reuses:

- The env-source helper (`set -a; . $(readlink .env.cogni); set +a`).
- The `cogniApiGet` / bearer-auth fetcher.
- The Grafana Postgres query helper at `scripts/grafana-postgres-query.sh` (call via `runSql` shape).
- The HTML report scaffolding (KPI cards, matrix table, fence-block evidence).

New code:

1. **Tenant discovery.** Glob `process.env` for `POLY_<ENV>_TENANT_<ROLE>_API_KEY` keys; pair with the matching `_BILLING_ACCOUNT_ID`. Reject any half-block (key present, account missing) with a clear error.
2. **Per-tenant metric assembly.** Pure functions over decision/fill rows.
3. **A/B compare.** Pure function; takes (control_metrics, treatment_metrics) → ranked deltas.
4. **HTML render.** Templated; injects KPI band + matrix table + per-tenant timeline.

### Skill: `.claude/skills/tenant-matrix-evaluator/SKILL.md`

Same shape as `.claude/skills/delta-minimizer/SKILL.md`:

- Required reading (this spec + the charter).
- Workflow (run script → cross-reference code → author finding → write `findings.json` + the takeaway block).
- Output rules (one primary finding, % confidence required, max two findings, file:line citations).
- Common failures (treating noise as signal, missing sample-size caveats, fabricating winrate without resolved-market grounding).

## Invariants

- `TENANT_SET_FROM_ENV` — tenants discovered from `POLY_<ENV>_TENANT_<ROLE>_*` env globbing. NOT hard-coded. Adding a tenant to the charter + the env file makes it appear automatically in the next run.
- `EVALUATOR_IS_READ_ONLY` — no `POST`, `PATCH`, or `DELETE` against any tenant. No writes to any DB. No mutation of `.env.cogni`. The script is reproducible across runs.
- `WINRATE_REQUIRES_RESOLVED_OUTCOMES` — winrate denominator counts ONLY markets in `poly_market_outcomes` with resolution within the window. Open markets contribute to unrealized PnL but not winrate.
- `FINDING_IS_LLM_AUTHORED` — the script writes the `findings.json` stub and the `<!-- TAKEAWAY -->` placeholder; the running agent fills both based on the bundle. NEVER auto-generate a finding from the data alone — sample size + context are part of the judgment.
- `BUNDLE_IS_SOURCE_OF_TRUTH` — `bundle.json` carries every datum the report cell shows. If a cell can't be derived from the bundle, it doesn't go in the report.

## Validation (per /validate-candidate or manual)

This skill itself doesn't deploy code that runs in production — it's a research/observation tool. Validation is therefore narrower than the candidate-flight loop.

### Done condition

- [ ] `pnpm tsx nodes/poly/scripts/tenant-matrix-evaluator.ts 0x204f72f35326db932158cba6adff0b9a1da95e14` (swisstony) executes against the current `.env.cogni` and:
  - Writes a non-empty `bundle.json` covering all 5 controllable tenants (prod live + preview trust-twin + preview gap + cand-a validation + cand-a gap).
  - Writes a `report.html` with the matrix table populated.
  - Writes a `findings.json` stub.
- [ ] Reading the matrix table, an agent can identify (in narrative form) which tenant has the lowest `delta_vwap` and which has the highest `placement_rate`, with the underlying numbers traceable to the bundle.
- [ ] LLM-authored top finding posted to the report's TAKEAWAY block and to `findings.json`. Finding cites file:line in `plan-mirror.ts` if it claims a planner-side root cause; cites the delta-minimizer charter D-class otherwise.
- [ ] No write operations performed against any tenant during the run (asserted by grep of stderr/log lines for POST/PATCH/DELETE on `poly-*.cognidao.org`).
- [ ] Unit tests cover the metric calculators with fixture data drawn from the existing delta-minimizer bundle.

### Per-environment exercise

| ENV   | EXERCISE                                                    | EXPECTED                                                                                                           |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| local | Run the script with all 5 keys present                      | bundle/report/findings written; no API errors                                                                      |
| local | Remove one tenant's `_BILLING_ACCOUNT_ID` (keep `_API_KEY`) | script errors with "half-block detected: POLY*<ENV>\_TENANT*<ROLE>\_BILLING_ACCOUNT_ID missing" and exits non-zero |
| local | Run with `--since` 30 days back                             | bundle reflects expanded window; no timeouts                                                                       |

### Observability

- Pino logs (or simple console JSON if no pino): one line each for `evaluator.start`, `evaluator.tenant_query.start { role }`, `evaluator.tenant_query.complete { role, decisions, placed }`, `evaluator.bundle.written { path }`, `evaluator.report.written { path }`, `evaluator.complete`.
- All log lines structured JSON with `event` field; no free-form strings.

### Sample-size discipline

Windowed metrics with `decisions < 50` or `resolved_markets < 3` MUST flag the matrix row with a 🟡 "low sample" note. LLM finding MUST acknowledge the floor and refuse to claim a winner under it.

## Pointers

- `chr.poly-algo-tenant-matrix` — the matrix this skill consumes
- `chr.poly-copy-delta` — failure-mode taxonomy that supplies D-class labels for findings
- `nodes/poly/scripts/paper-twin-diff.ts` — the implementation predecessor; reuse the env-source + fetch + render helpers
- `.claude/skills/delta-minimizer/SKILL.md` — output rules, finding discipline, % confidence convention
- `.claude/skills/paper-trade-diff-analysis/SKILL.md` — the sibling trust-signal skill; its constraints carry over
- `.env.cogni.example` — the per-tenant key block shape (`POLY_<ENV>_TENANT_<ROLE>_{API_KEY, BILLING_ACCOUNT_ID}`)

## Status notes

- **2026-05-18:** Spec drafted as the third sibling skill in the cross-PR observation trio. Triggered by chr.poly-algo-tenant-matrix landing with no continuous observation surface for the matrix it governs. Handoff in section below.
