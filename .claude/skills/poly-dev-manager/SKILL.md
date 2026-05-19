---
name: poly-dev-manager
description: "Top-level router for Cogni's Polymarket poly node. Load this skill for any poly work; it routes you to the right specialty skill (copy-trading loops, market-data / CLOB / Data-API, or auth & wallets). Use when starting a poly task, triaging a poly bug, reviewing a poly PR, or anytime the work smells poly-adjacent but you don't yet know which sub-domain. Also triggers for: 'work on the poly node', 'poly bug', 'review this poly PR', 'what does the poly node do', 'which poly skill do I need', 'poly roadmap', 'Phase 3 / Phase 4', 'task.0318 / task.0315 / task.0322', 'mirror trade Polymarket wallet', 'fix poly in candidate-a'."
---

# Poly Dev Manager

You are the orientation layer for Cogni's poly node. This file is intentionally short: it gets you to the specialty skill you actually need.

## What the poly node does (one paragraph)

Takes a Polymarket wallet that demonstrably trades with edge and mirrors its fills onto a Cogni-controlled trading wallet. Target wallet trades → `wallet-watch` detects (Data-API `/trades` poll, with WS wake-up after #1172) → `mirror-coordinator` decides → `INSERT_BEFORE_PLACE` ledger row lands → `PolymarketClobAdapter` signs via Privy HSM → CLOB receipt. v0 shipped single-operator; Phase A shipped RLS on copy-trade tables; Phase B (task.0318, `deploy_verified` 2026-04-22) shipped per-tenant Privy trading wallets. Phase 4 (task.0322) will swap the 30s poll for CLOB WebSocket + adversarial-robust target ranking.

## Current state — read these (don't trust a snapshot in this file)

Static facts here rot in days. For what's actually happening right now, read in this order:

1. **`work/charters/POLY_ALGO_TENANT_MATRIX.md`** — current tenant matrix (per-env, per-role), which sizing policy each tenant runs, target wallets, and current pXX / allocation snapshots. Source of truth for "what policies are under test today."
2. **`work/charters/POLY_COPY_DELTA.md`** — failure-mode taxonomy (D1–D8) every delta/matrix report cites.
3. **`work/projects/proj.poly-copy-trading.md`** — active roadmap, open bugs, constraints.
4. **`git log --first-parent main -20 --oneline`** — what's actually shipped in the last week.
5. **Active poly bugs**: `GET https://poly.cognidao.org/api/v1/work/items?node=poly&types=bug&statuses=needs_implement,in_review`

**Active sizing policies (as of 2026-05-18):**

- **`target_percentile_scaled` (legacy "tps")** — original v0 policy. Target position must clear a pXX threshold; size scales between pXX and p99, capped at `max_usdc_per_trade` (legacy $15 cap on production LIVE tenant). Hardcoded pXX tables live in `copy-trade-mirror.job.ts`.
- **`position_gap` (PR #92 / #103, D2 phase 2)** — proportional book-copy. Allocates a fixed `mirror_capital_alloc_usdc`; per-token target is `alloc × (target_token_position / target_total_book)`; mirrors what's missing. Ignores `max_usdc_per_trade` entirely. Active on preview SWISSTONY_TRUST_TWIN + various GAP tenants; **dormant on prod LIVE** (per-tenant config opt-in).

Source of truth for policy dispatch: `nodes/poly/app/src/features/copy-trade/plan-mirror.ts`. Per-tenant `sizing_policy_kind` lives in `poly_copy_trade_targets` rows + charter.

**Observability:** Loki is the operational truth. Mirror decisions: `event="poly.mirror.decision"` from `{container="app"}`. Paper sidecar fills: `event="adapter.paper_sidecar.order_filled"` from `{container="poly-paper-sidecar"}`. Service label is `service="app"` for the TS pod (NOT `poly-node-app` — that's the pod name). Metrics are mostly `noopMetrics` in candidate-a bootstrap; don't assume Prometheus counters exist.

**Operational data tables**: the rosetta-stone block below is durable (table → owner → caveats). Backfill stories for newer tables are also captured there. Don't re-derive that from scratch.

## Which skill to load

| If you're doing…                                                                                                                                                                            | Load                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Mirror pipeline, coordinator, wallet-watch, `poly_copy_trade_*` tables, v0 caps, poll cadence, shared-poller, Phase-4 streaming prep                                                        | [`poly-copy-trading`](../poly-copy-trading/SKILL.md)                                                                                    |
| CLOB order placement, Data-API reads, fill-id semantics, EOA-vs-Safe-proxy gotchas, target-wallet screening / ranking research                                                              | [`poly-market-data`](../poly-market-data/SKILL.md)                                                                                      |
| Per-tenant `/api/v1/poly/wallet/connect`, Privy provisioning, `poly_wallet_connections`, CTF + USDC.e approvals, AEAD at rest, CustodialConsent, validating `deploy_verified`               | [`poly-auth-wallets`](../poly-auth-wallets/SKILL.md)                                                                                    |
| Research views, dashboard slices, P/L curves, histograms, comparison panels, SQL-vs-V8 aggregation, OOM diagnosis on `poly_trader_fills` / `poly_trader_position_snapshots` reads, backfill | [`data-research`](../data-research/SKILL.md)                                                                                            |
| Paper sidecar bugs, paper-twin fidelity vs LIVE, paper fill-price correctness, partial-fill bookkeeping, anything in `nodes/poly/sidecars/paper-trader/`, recent: bug.5015, bug.5016        | [`paper-trade-diff-analysis`](../paper-trade-diff-analysis/SKILL.md) + [`tenant-matrix-evaluator`](../tenant-matrix-evaluator/SKILL.md) |
| A/B across multiple paper tenants on one target wallet, ranking sizing policies, "is position_gap beating tps", post-fix validation runs                                                    | [`tenant-matrix-evaluator`](../tenant-matrix-evaluator/SKILL.md) (then `paper-trade-diff-analysis` for single-tenant deep dive)         |
| One specific market where our mirror diverged from the target's fill (wrong side, wrong VWAP, missed mirror)                                                                                | [`delta-minimizer`](../delta-minimizer/SKILL.md)                                                                                        |

Load multiple if you're crossing domains (e.g., a research view that drives a target-ranking change is `data-research` + `poly-copy-trading`). Each specialty skill is self-contained; there is no "base" you have to load first.

## Canonical references (cross-cutting)

**Specs (as-built):**

- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — Phase 1 layer boundaries, invariants, `fill_id` shape
- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — order status vs position lifecycle vs redeem job state machine
- [docs/spec/poly-tenant-and-collateral.md](../../../docs/spec/poly-tenant-and-collateral.md) — Phase A tenant-scoped copy-trade tables + RLS
- [docs/spec/poly-tenant-and-collateral.md](../../../docs/spec/poly-tenant-and-collateral.md) — Phase B `PolyTraderWalletPort` (AEAD, consent, invariants)

**Current design/research pointers:**

- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — `MirrorPositionView`, position authority boundaries, follow-up branch predicates, decision-log observability contract
- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — canonical position model; do not confuse local mirror policy cache with chain/Data API authority
- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — current as-built hardcoded RN1/swisstony target-position pXX policy
- [docs/research/poly/layering-policy-spike-2026-05-02.md](../../../docs/research/poly/layering-policy-spike-2026-05-02.md) — historical layering research; do not treat its order-flow pXX as the active position-pXX policy
- [nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts](../../../nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts) — current hardcoded v0 sizing snapshots and position-follow-up defaults
- [nodes/poly/app/src/features/copy-trade/plan-mirror.ts](../../../nodes/poly/app/src/features/copy-trade/plan-mirror.ts) — pure planner for pXX, layer, hedge, and SELL-close branch decisions
- [nodes/poly/app/src/features/copy-trade/mirror-pipeline.ts](../../../nodes/poly/app/src/features/copy-trade/mirror-pipeline.ts) — sequencing, target-position hydration, ledger decision recording, Loki fields

**Guides:**

- [docs/guides/poly-wallet-provisioning.md](../../../docs/guides/poly-wallet-provisioning.md) — per-tenant flow + honest architecture accounting
- [docs/guides/polymarket-account-setup.md](../../../docs/guides/polymarket-account-setup.md) — shared-operator onboarding (legacy)

**Operational data tables (where research / data-science work lands):**

| Table                                                   | Owner / writer                                                   | Coverage caveats                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `poly_trader_fills`                                     | `wallet-watch` + spike.5024 historical walker                    | Full Polymarket history for tracked wallets after spike.5024 (RN1, swisstony walked from Apr) |
| `poly_trader_position_snapshots`                        | `wallet-analysis-service` snapshot writer                        | **Started writing 2026-05-03**; pre-May-3 must be derived from fills (cumsum) for backfill    |
| `poly_trader_current_positions`                         | dashboard refresh path                                           | Live, refreshed on read; not a historical record                                              |
| `poly_trader_user_pnl_points`                           | db-backed user-pnl read model (#1242)                            | Walked back via spike.5024 corpus                                                             |
| `poly_market_metadata`                                  | canonical Gamma persistence (#1265, #1270)                       | **Started writing 2026-05-05**; backfill via Gamma `/markets/{conditionId}` per condition     |
| `poly_market_outcomes`                                  | `runMarketOutcomeTick` — condition-iterating writer (cp3, #1247) | **Started writing 2026-05-05**; reuse forward-fill loop with one-shot driver over conditions  |
| `poly_market_price_history`                             | cp7 db mirror (#1251)                                            | **Started writing 2026-05-05**; backfill via CLOB `/price-history?market={tokenId}`           |
| `poly_copy_trade_{targets,fills,decisions,attribution}` | mirror coordinator                                               | See [`poly-copy-trading`](../poly-copy-trading/SKILL.md) for invariants + RLS                 |
| `poly_redeem_jobs`                                      | redeem worker (Capability B, #1242)                              | event-driven; cleared by completion                                                           |
| `poly_wallet_{connections,grants}`                      | per-tenant onboarding                                            | See [`poly-auth-wallets`](../poly-auth-wallets/SKILL.md)                                      |

**Project charter + work items:**

Work items live in this repo's API at `https://poly.cognidao.org/api/v1/work/items` (Doltgres-backed):

- [proj.poly-copy-trading](../../../work/projects/proj.poly-copy-trading.md) — full roadmap, open bugs, constraints (still markdown)
- [chr.poly-copy-delta](../../../work/charters/POLY_COPY_DELTA.md) — failure-mode taxonomy (D1–D8 classes); every delta-minimizer report cites a row here
- [chr.poly-algo-tenant-matrix](../../../work/charters/POLY_ALGO_TENANT_MATRIX.md) — per-(env, tenant) paper-trading accounts we operate for algo A/B; tells you which `POLY_<ENV>_TENANT_<ROLE>_*` env key drives which tenant, and which policies are under test
- Active poly items: `GET https://poly.cognidao.org/api/v1/work/items?node=poly&statuses=needs_implement,needs_design,in_review`
- Specific item: `GET https://poly.cognidao.org/api/v1/work/items/{id}` (e.g. `task.5012`, `task.0322`, `bug.5012`, `spike.5024`)

## Anti-patterns that bite everywhere (regardless of specialty)

- **Placing a test trade from a wallet you control and calling it "mirror validation."** The mirror copies the TARGET. If the target didn't trade, the mirror has nothing to copy. True of shared operator, true of your own per-tenant wallet, true of raw-PK test wallets.
- **Smuggling P4 (streaming / ranking) work into a v0 or v1 task.** P4 is tracked in task.0322. Scope discipline matters here because the fill_id shape is frozen (`data-api:…`) and mixing schemes corrupts the idempotency layer.
- **`kubectl set env` for long-lived config.** Argo reverts on next sync. Secrets go through `scripts/setup/setup-secrets.ts` → `candidate-flight-infra`; config goes into the kustomize overlay.
- **Re-setting GH env secrets without checking `gh secret list --env candidate-a` first.** Rotates tokens out from under live flights.
- **Trusting the Polymarket UI profile for EOA-direct wallets.** The `/profile/<addr>` page redirects to an empty Safe-proxy. Use Data-API `/positions` / `/trades` or Polygonscan. See [`poly-market-data`](../poly-market-data/SKILL.md) for the full ground-truth order.

## Observability backstop (MCP-down fallback)

`grafana` MCP is flaky. When it's down, use [`scripts/loki-query.sh`](../../../scripts/loki-query.sh) — accepts raw LogQL, hits Grafana Cloud via service-account token, auto-sources `.env.canary` / `.env.local`. Same LogQL syntax as the MCP. Used to flip `deploy_verified` on task.0318 on 2026-04-22.

## Cross-cutting enforcement

Rules that apply regardless of which specialty you're in:

- **Never use raw PKs in production code paths.** `scripts/experiments/` only. Production signs via Privy HSM (shared or per-user).
- **Never skip `INSERT_BEFORE_PLACE`** in the coordinator — at-most-once correctness gate.
- **`fill_id` shape is frozen** at `data-api:<tx>:<asset>:<side>:<ts>`. P4 will add `clob-ws:…`. Never mix schemes within one fill.
- **Idempotency is always `keccak256(target_id + ':' + fill_id)` → `client_order_id`.** No alternatives.
- **`deploy_verified: true` requires the full validation recipe**, not just `pnpm check`. See [`poly-auth-wallets`](../poly-auth-wallets/SKILL.md) for the per-tenant provisioning recipe.
