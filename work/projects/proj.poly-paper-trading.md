---
id: proj.poly-paper-trading
type: project
primary_charter:
title: "Poly — Paper Trading Mode for the Copy-Trade Mirror"
state: Active
priority: 1
estimate: 2
summary: "Run the live copy-trade algorithm end-to-end against an OSS fill engine (agent-next/polymarket-paper-trader, MIT) instead of the CLOB. The PaperAdapter stub (already MarketProviderPort-typed) becomes a thin sidecar client. The 3-environment Kustomize topology (candidate-a / preview / production) already exists — flipping `PAPER_ENFORCE_MODE=paper` on the first two overlays delivers the always-paper twin plus PR-level safety against burning real money. No new ports, no new deployment infrastructure, no fill logic written by us."
outcome: "Success is when an AI agent can land an algorithm change as a PR, watch it flight to candidate-a (paper-enforced) and pass /validate-candidate against simulated fills, merge to main, observe its continuous behaviour on preview's always-paper twin for days, and then promote the same SHA to production live trading — without any of those environments requiring code that simulates fills or matches orders. The fill model lives upstream in agent-next/polymarket-paper-trader; we own only the adapter and the deploy topology."
assignees: derekg1729
created: 2026-05-14
updated: 2026-05-14
labels:
  [
    poly,
    polymarket,
    copy-trading,
    paper-trading,
    oss-first,
    candidate-a,
    preview,
  ]
---

# Poly — Paper Trading Mode for the Copy-Trade Mirror

> Spun out of `proj.poly-copy-trading` on 2026-05-14 after the research spike at [`docs/research/poly-paper-trading-mode.md`](../../docs/research/poly-paper-trading-mode.md). The parent project owns live copy-trade placement; this project owns the paper-mode backend and the always-paper deployment topology that the AI-iteration loop runs on.

## Goal

Run the **full mirror algorithm end-to-end** — `planMirrorFromFill`, `OrderLedger.insertPending`, decision audit, observability, the 30s `MIRROR_POLL_MS` lag, market-constraints check, cap enforcement — with **only** the final CLOB-place swapped for an OSS paper engine. Use the three Kustomize overlays we already have so that:

- `candidate-a` (every flighted PR) is paper-enforced — bugs never burn real money.
- `preview` is the continuous always-paper twin where the AI iterates against live order books over days/weeks.
- `production` continues as today; per-target `mode` lets new wallets enter as `paper` before promoting to `live`.

The strict constraint is that **we write no fill logic**. The fill model lives in [`agent-next/polymarket-paper-trader`](https://github.com/agent-next/polymarket-paper-trader) (MIT). Strategy constraints — limit-orders-only and ride-to-redemption — eliminate the failure modes (SELL slippage, neg-risk SELL routing, market-order partial fills) that would otherwise force us to model matching engine behaviour. Realistic fidelity under these constraints: ~96-98%, irreducible gap is queue position at congested price levels.

## Roadmap

### Execution plan — 2 PRs

> **Work item tracking lives in this file**, not in the operator API. We're actively fixing work-item tracking elsewhere; for this project, this `.md` is canonical. Tick the checkboxes as each piece lands.

#### PR 1 — Paper engine end-to-end (production-deployable, dormant until enabled)

Ships the TS architecture only. All `infra/**` artifacts (sidecar Dockerfile + image build + overlay patches) move to PR 2 because PR 1 has to pass `single-node-scope` CI gate (which classifies `infra/**` as operator-domain and rejects cross-node PRs). PR 1 is poly-only + ride-along `docs/` + `work/`. **Smoke test post-merge:** all 3 environments deploy cleanly with no behaviour change; PR 1 is dormant infrastructure.

**Hard ordering inside PR 1**: the executor dispatcher (item 5) must merge before the bootstrap DB-mode read (item 8). Both are in the same PR so they cannot ship out of order, but if PR 1 gets split, the dispatcher half must land first.

| #   | Deliverable                                                                                                                                                             | Status | Files                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 1   | Sidecar Dockerfile + FastAPI placeholder — DEFERRED to PR 2 (single-node-scope CI gate blocks `infra/**` in a poly-only PR)                                             | [ ]    | `infra/images/poly-paper-sidecar/` (PR 2)                                                              |
| 2   | Sidecar sibling container — added to candidate-a + preview overlay patches in PR 2 (NOT the base manifest, to keep production unaffected until paper-mode is wanted)    | [ ]    | `infra/k8s/overlays/{candidate-a,preview}/poly/kustomization.yaml` (PR 2)                              |
| 3   | `PaperAdapter` body — Zod IPC client; delegates `getMarketConstraints` + `listMarkets` to `readSource`; populates `OrderReceipt.filled_size_usdc`                       | [ ]    | `nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts`                              |
| 4   | `FakePaperAdapter` for `APP_ENV=test` — canned responses, no IPC                                                                                                        | [ ]    | `nodes/poly/app/tests/_fakes/paper-adapter.fake.ts`                                                    |
| 5   | Executor dispatcher — dual `ClobExecutor`, branches on `intent.attributes.mode`, reads `PAPER_ENFORCE_MODE`, refuses `PolyTraderWalletPort.resolve()` when paper-forced | [ ]    | `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts`                                     |
| 6   | `attributes.mode` stamp in mirror-pipeline — reads `MirrorTargetConfig.mode` from `deps.target`, stamps on BUY + SELL-close intents                                     | [ ]    | `nodes/poly/app/src/features/copy-trade/mirror-pipeline.ts`                                            |
| 7   | Schema migration — `mode` column on `poly_copy_trade_fills` + `poly_copy_trade_decisions`, NOT NULL DEFAULT `'live'`. Follow `/schema-update`.                          | [ ]    | `nodes/poly/packages/poly-db-schema/`, migration                                                       |
| 8   | Bootstrap reads DB `mode` — remove hardcoded `"live"` at `copy-trade-mirror.job.ts:243`                                                                                 | [ ]    | `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts`                                           |
| 9   | Position aggregation paper-awareness — `closePosition` / `exitPosition` read from `poly_copy_trade_fills WHERE mode='paper'` instead of Data-API for paper-mode targets | [ ]    | `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts` (~lines 416, 514)                   |
| 10  | Paper-redemption job — watches `ConditionResolution`, stamps `poly_copy_trade_fills.position_lifecycle` for `mode='paper'` on resolution                                | [ ]    | `nodes/poly/app/src/features/redeem/paper-redemption.ts` (new) + `bootstrap/redeem-pipeline.ts` wiring |
| 11  | Spec update — `attributes.mode` discriminator documented alongside `attributes.placement`                                                                               | [ ]    | `docs/spec/poly-copy-trade-execution.md`                                                               |
| 12  | Tests — `PaperAdapter` (full/partial/cancel/getOrder), dispatcher branch, `attributes.mode` propagation, paper-redemption against resolved-market fixture               | [ ]    | `nodes/poly/app/tests/unit/**`, `nodes/poly/packages/market-provider/tests/**`                         |

#### PR 2 — Always-paper overlays (trivial; gated on VMs)

**Prerequisite:** `candidate-a.vm.cognidao.org` and `preview.vm.cognidao.org` VMs exist. Derek is provisioning these in parallel with PR 1 via `/deploy-node` (Cherry Servers + OpenTofu + k3s + Argo CD).

Bootstrap CLOB-creds refusal lands in PR 1 (item 5). PR 2 is purely two ConfigMap patches.

| #   | Deliverable                                                           | Status | Files                                                              |
| --- | --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| 1   | Provision `candidate-a` VM                                            | [ ]    | external — Derek runs `/deploy-node`                               |
| 2   | Provision `preview` VM                                                | [ ]    | external — Derek runs `/deploy-node`                               |
| 3   | Sidecar Dockerfile + FastAPI placeholder server (moved from PR 1)     | [ ]    | `infra/images/poly-paper-sidecar/{Dockerfile,server.py,AGENTS.md}` |
| 4   | Sidecar image build + push to `ghcr.io/cogni-dao/poly-paper-sidecar`  | [ ]    | `.github/workflows/`                                               |
| 5   | Sidecar sibling container patched onto candidate-a + preview overlays | [ ]    | `infra/k8s/overlays/{candidate-a,preview}/poly/kustomization.yaml` |
| 6   | `PAPER_ENFORCE_MODE: "paper"` on candidate-a overlay ConfigMap        | [ ]    | `infra/k8s/overlays/candidate-a/poly/kustomization.yaml`           |
| 7   | `PAPER_ENFORCE_MODE: "paper"` on preview overlay ConfigMap            | [ ]    | `infra/k8s/overlays/preview/poly/kustomization.yaml`               |

#### Polish (post-PR-2, opt-in per friction signal)

Each item below only earns its place by real signal during PR 1 / PR 2 use, not by speculation.

| #   | Deliverable                                                                  | Status |
| --- | ---------------------------------------------------------------------------- | ------ |
| 1   | CODEOWNERS scope `nodes/poly/app/src/features/copy-trade/**` to AI agent     | [ ]    |
| 2   | Per-environment Grafana panels (candidate-a / preview / prod, `mode` filter) | [ ]    |
| 3   | CI fee-drift smoke test against `pm-trader`'s known fixture                  | [ ]    |
| 4   | Docs + runbook for the iteration loop end-to-end                             | [ ]    |

## Constraints

- **We write no fill logic.** Fill model lives in `agent-next/polymarket-paper-trader`. If it has bugs, we file upstream issues; we do not fork until forced to.
- **Limit-orders only, ride-to-redemption only.** These strategy constraints make the OSS sim usable. If either changes, the fidelity story breaks and this project's premise must be re-evaluated.
- **No new ports.** `MarketProviderPort` exists. `PaperAdapter implements MarketProviderPort` exists. We only fill in the stub body.
- **No new deployment environments.** `candidate-a`, `preview`, `production` already exist as Kustomize overlays. `PAPER_ENFORCE_MODE` is a 3-line patch per overlay — not a fourth overlay.
- **No separate repo.** Copy-trade code stays in `nodes/poly` monorepo. AI agent ownership lives in CODEOWNERS, not in a repo split.
- **The algorithm must run in paper mode.** Shadow-attribution (recording target's actual fill price scaled) was considered and rejected — it bypasses the algorithm. If the algorithm doesn't exercise end-to-end, paper-mode data is useless for catching algorithm bugs.
- **Belt-and-suspenders on the paper environments.** When `PAPER_ENFORCE_MODE=paper` is set, the bootstrap refuses to even load live CLOB credentials. An env-var typo cannot route a real order.

## Dependencies

- [x] `MarketProviderPort` interface at `nodes/poly/packages/market-provider/src/port/market-provider.port.ts:128`
- [x] `PaperAdapter` P1 stub (`nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts`) — shape frozen, body lands in this project
- [x] `MirrorTargetConfig.mode: "paper" | "live"` in v1 contract (`nodes/poly/packages/node-contracts/src/poly.copy-trade.targets.v1.contract.ts:54`)
- [x] `planMirrorFromFill` paper-mode routing (`plan-mirror.ts:534` already emits `mode_paper`)
- [x] Three Kustomize overlays for the poly node: `infra/k8s/overlays/{candidate-a,preview,production}/poly/kustomization.yaml` (overlays exist; **candidate-a and preview VMs not yet provisioned — see P1 prerequisites**)
- [x] Live `ConditionResolution` on-chain redemption listener (covers paper redemptions identically)
- [x] `getMarketConstraints(tokenId)` for tick + min-size (already called pre-place in live mode)
- [ ] Hardcoded `mode: "live"` removal at `copy-trade-mirror.job.ts:243` — lands in P0
- [ ] `agent-next/polymarket-paper-trader` pinned commit — lands in P0

## As-Built Specs

- (none yet — created when P0 lands)

## Design Notes

### Why an OSS sidecar, not our own fill model

The user's strict constraint: any fill logic we write can diverge from reality, and divergent data is worse than no data. Survey of OSS Polymarket sim engines (full results in [`docs/research/poly-paper-trading-mode.md`](../../docs/research/poly-paper-trading-mode.md)):

- `agent-next/polymarket-paper-trader` — MIT, wire-correct Polymarket fee formula, walks the live book — **chosen.**
- `braedonsaunders/homerun` — AGPL-3.0, has Cox-hazards queue model (best fidelity), **license blocker** for a hosted node service.
- `nautilus_trader` + Kolberg adapter — backtest-grade, live-paper alpha is BTC-5m only.
- All others — abandoned, wrong tool, or no sim layer.

`agent-next` is the only viable choice. Sidecar process boundary (same k3s pod, sibling container) keeps the dependency upstream-pristine — `git pull` in the sidecar Dockerfile to pick up upstream fixes.

### Why the algorithm must run end-to-end (shadow-attribution rejected)

Earlier proposal: when target fills, record a shadow row at target's actual price scaled to our size. Rejected because it skips:

- The 30s `MIRROR_POLL_MS` lag between target's fill and our place attempt. Book may have moved.
- Polymarket min-order-size in USDC. If target fills $200 and our scaled mirror is $1.50, that may fall below market min and skip — shadow ignores this.
- Tick-size rounding (Polymarket ticks at 0.01). Our limit gets rounded; target's fill price did not.
- The planner's own decision lattice (sizing scale-in, cap enforcement, layer-scale-in heuristics).

For algorithm validation, the algorithm must run. Shadow only validates the target's strategy, not our code.

### Why `preview` is the always-paper twin (not a new `poly-paper.cognidao.org`)

A fourth Kustomize overlay would mean: new VM, new Argo app, new DB, new ingress, new DNS, new Grafana scope. `preview` is already a continuous deployment of the poly node with its own DB. Flipping `PAPER_ENFORCE_MODE=paper` in its ConfigMap patch is a 3-line change that reuses everything. A separate deployment is justified only if `preview` namespace contention becomes a real problem — defer until signal arrives.

### Why monorepo, not a separate repo for the AI agent

Type-sharing (Zod contracts in `@cogni/poly-node-contracts`) is monorepo-native and load-bearing. The algorithm imports from `MarketProviderPort`, `OrderLedger`, `OrderIntent`, `OrderReceipt` — all `nodes/poly` internals. A separate repo forces these into semver-versioned packages; that's a large tax. CODEOWNERS gets the ownership boundary without the split: scope `nodes/poly/app/src/features/copy-trade/**` to the AI agent's identity, and PRs touching that subtree route to the agent for review. Revisit only if iteration cadence overruns the candidate-a slot.

### Why `PAPER_ENFORCE_MODE` belt-and-suspenders

Setting an env var on `candidate-a` and `preview` is necessary but not sufficient — a future refactor could silently drop the env-var read. The bootstrap also refuses to load live CLOB credentials at all when `PAPER_ENFORCE_MODE=paper` is set. Two independent failsafes; either alone catches the bug.

### The honest fidelity ceiling

~96-98% under our limit-only + ride-to-redemption constraints. The irreducible OSS gap is queue position at congested price levels. For v0 cap sizes ($1-50/trade) in low-liquidity copy-trade markets, the gap is small. We don't apply a confidence haircut to dashboards — algorithm validation is binary (does the code path execute correctly), not probabilistic. Caveat documented in the runbook (P2).

## Design

> The /design pass. Refines outcome, extracts invariants, and chooses the simplest path.

### Refined outcome

_"Success is when an AI agent can land an algorithm change as a PR, watch it flight to candidate-a (paper-enforced) and pass /validate-candidate against simulated fills, merge to main, observe its continuous behaviour on preview's always-paper twin for days, and then promote the same SHA to production live trading — without any of those environments requiring code that simulates fills or matches orders."_

The two through-line invariants are: (a) the algorithm exercises identically across all three environments, and (b) we write no fill logic.

### Invariants extracted from surrounding specs

Loaded from `nodes/poly/packages/market-provider/AGENTS.md`, `nodes/poly/app/src/features/{copy-trade,trading}/AGENTS.md`, `nodes/poly/app/src/bootstrap/capabilities/AGENTS.md`, `docs/spec/packages-architecture.md`.

- `MARKET_PROVIDER_SHAPE_FROZEN` — the `PaperAdapter` constructor and method list (`listMarkets`, `placeOrder`, `cancelOrder`, `getOrder`, `getMarketConstraints`) don't change in this project; only bodies land. (`paper.adapter.ts:8`)
- `PACKAGES_NO_ENV` (packages-architecture.md `PURE_LIBRARY`) — the sidecar client lives in `@cogni/poly-market-provider`; the sidecar host string is constructor-injected. Env reads (sidecar host, `PAPER_ENFORCE_MODE`) live in `nodes/poly/app/src/bootstrap/`, not in the adapter.
- `EXECUTOR_SEAM_IS_PLACE_ORDER_FN` (trading/AGENTS.md) — `createClobExecutor` takes a `placeOrder(intent) => receipt` function, not an adapter instance. The dispatcher pre-builds **two** `ClobExecutor` instances (`livePlace`, `paperPlace`) — one wrapping each adapter's `placeOrder` — and selects between them per call. Metrics + structured logs bucket cleanly per path.
- `PLACEMENT_DISCRIMINATOR_IN_ATTRIBUTES` (copy-trade/AGENTS.md) — `intent.attributes.placement ∈ {"limit","market_fok"}` is the only source of truth for adapter order-type. **The shared `OrderIntent` port stays clean.** We extend the same discriminator convention: `intent.attributes.mode ∈ {"live","paper"}`. Zero schema lift — `OrderIntent.attributes` is already `z.record(z.string(), z.unknown()).optional()` (`order.ts:74`).
- `PLANNER_IS_PURE` (copy-trade/AGENTS.md) — `planMirrorFromFill` has no I/O, no env reads, no clock reads. **The planner does NOT construct `OrderIntent`** — it returns a `MirrorPlan`. The intent is assembled in `mirror-pipeline.ts` (see :901 for the SELL-close intent example with its `attributes` blob); the BUY intent is built similarly. **That** is where `attributes.mode` gets stamped — `mirror-pipeline.ts` reads `MirrorTargetConfig.mode` from `deps.target` and sets `attributes.mode` on the assembled intent. Planner stays pure. The `PAPER_ENFORCE_MODE=paper` env override happens later, in the executor dispatcher.
- `TRADING_IS_GENERIC` (trading/AGENTS.md) — the trading layer can carry a `mode` column on the fills table; vocabulary stays generic ("order mode," not "paper trade").
- `INSERT_BEFORE_PLACE` (mirror-pipeline.ts:10-11) — `insertPending()` fires before `executor()`. Paper mode preserves this — the ledger row is written before the sidecar call. Sidecar crash leaves a `pending` row that the reconciler handles identically to a live pending row.
- `CAP_COUNTS_REALIZED_ON_CANCEL` (bug.5050, trading/AGENTS.md) — `cumulativeIntentForMarket` counts canceled rows by `filled_size_usdc`. The paper adapter MUST populate `filled_size_usdc` accurately when the sidecar reports a paper fill (full or partial). Without this, paper-mode caps drift and the cap-enforcement code path can't be exercised against paper trades the way it would be against live.
- `IDEMPOTENT_BY_CLIENT_ID` (copy-trade/AGENTS.md) — same `(target_id, fill_id)` is silently dropped. Paper mode keeps this — the sidecar receives a `client_order_id` and treats it idempotently.
- `NO_SELL_IN_MIRROR` (copy-trade/AGENTS.md) — confirms the ride-to-redemption strategy constraint. Paper adapter does not implement SELL; if a future SELL path lands, paper-mode fidelity story breaks and the project's premise must be re-evaluated.
- `MIRROR_BUY_CANCELED_ON_TARGET_SELL` (copy-trade/AGENTS.md) — the cancel path routes through `executor.cancelOrder`. Paper adapter must support `cancelOrder` (already in the `MarketProviderPort` shape and the P1 frozen stub).
- `PRICE_TICK_NORMALIZED` (copy-trade/AGENTS.md) — `getMarketConstraints` is called pre-place to round to valid ticks. Paper mode must use **live** market constraints (real ticks, real min-size) — the `PaperAdapter` delegates `getMarketConstraints` to an injected `readSource: MarketProviderPort` (already in `PaperAdapterConfig`). Otherwise paper trades would round to fake constraints and miss the tick/min-size enforcement code path.

### Two approaches considered

**Approach 1 — Dual `ClobExecutor`, dispatch on `intent.attributes.mode` (chosen).** `buildExecutor()` in `bootstrap/capabilities/poly-trade-executor.ts` constructs both `PolymarketClobAdapter` (existing) and `PaperAdapter` (new) once per tenant at executor build, then builds **two** `ClobExecutor` instances — one wrapping each adapter's `placeOrder`. `authorizedPlace` runs `authorizeIntent` once, then dispatches on `intent.attributes.mode ?? "live"`. `cancelOrder` + `getOrder` paths dispatch the same way. `PaperAdapter`'s `getMarketConstraints` delegates to the live adapter (via the `readSource` field already in `PaperAdapterConfig`). `PAPER_ENFORCE_MODE=paper` env override happens at the top of `authorizedPlace`, forcing `attributes.mode = "paper"` regardless of what the planner emitted.

- Pros: one chokepoint, two pre-built ClobExecutor instances, both `EXECUTOR_SEAM_IS_PLACE_ORDER_FN` and `PLACEMENT_DISCRIMINATOR_IN_ATTRIBUTES` honored. Metrics + logs bucket per path automatically. No `OrderIntent` shape change. Decision audit, ledger writes, reconciler all unchanged.
- Cons: dispatcher logic lives in the executor — reasonable home; the executor is the only layer that knows about placement variants today.

**Approach 2 — Single ClobExecutor, branch inside the `placeOrder` function.** One `createClobExecutor` instance whose injected `placeOrder` is itself a dispatcher: `(intent) => intent.attributes.mode === "paper" ? paperAdapter.placeOrder(intent) : liveAdapter.placeOrder(intent)`.

- Pros: minimum LOC.
- Cons: metrics + structured logs from `createClobExecutor` collapse into a single bucket — can't tell live vs paper from a Prom panel without per-call inspection. Violates the spirit of `EXECUTOR_SEAM_IS_PLACE_ORDER_FN` (the seam is meant to be platform-specific). Harder to test paper vs live in isolation.

**Approach 3 — Branch above, per-tick adapter selection in `MarketProviderPort`.** Build a different adapter per-target per-tick. The executor doesn't dispatch.

- Pros: cleaner conceptually per-target.
- Cons: rebuilds adapter graphs per target (`PolymarketClobAdapter` construction does CLOB credential resolution); blurs bootstrap/runtime line; cold starts pay sidecar handshake on first paper fill.

**Choose Approach 1.** Single dispatcher in the executor, two pre-built `ClobExecutor` instances live across the whole executor lifetime, dispatch is a branch on `attributes.mode`. Smallest diff, best observability separation, preserves all existing invariants.

### Boundary placement

Applied per `docs/spec/packages-architecture.md` § Phase 3a + the `may_import` rules in each AGENTS.md.

- **Sidecar transport client** (`paper.adapter.ts` body): lives in `nodes/poly/packages/market-provider/src/adapters/paper/`. IPC + Zod parsing only. Constructor takes `sidecarHost: string` and `readSource: MarketProviderPort`. **No env reads, no process lifecycle** — `PURE_LIBRARY` holds.
- **`PaperAdapter` `getMarketConstraints` delegation**: delegates to `this.config.readSource.getMarketConstraints(tokenId)` so paper trades respect real tick + min-size. The `readSource` is the production `PolymarketAdapter` (Gamma reader). Already in `PaperAdapterConfig` from the P1 stub.
- **`PaperAdapter` `listMarkets`**: delegate to `readSource.listMarkets()`. Paper isn't a discovery surface; live discovery is correct.
- **Env var reads (`PAPER_SIDECAR_HOST`, `PAPER_ENFORCE_MODE`)**: live in `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts`. `buildExecutor()` reads them and passes them to the `PaperAdapter` constructor. Boundary `bootstrap → packages` is allowed; `packages → app/bootstrap` is not.
- **Dispatcher**: lives in `bootstrap/capabilities/poly-trade-executor.ts` — `bootstrap` is the only layer that may compose both adapters (it may import `adapters/server` and reach the `packages/`-resident port; trading and copy-trade features cannot).
- **Sidecar k8s manifest**: `infra/k8s/base/node-app/` — added as a sibling container in the pod template. All three overlays (`candidate-a`, `preview`, `production`) inherit. Per the bug.0295 ExternalName pattern already in use, the sidecar Service is loopback (`localhost:<port>`), not cluster-DNS.
- **Sidecar image build**: `infra/images/poly-paper-sidecar/Dockerfile` pins the `agent-next/polymarket-paper-trader` upstream commit SHA. CI builds it on changes to the directory only.
- **Belt-and-suspenders CLOB-creds refusal**: also in `poly-trade-executor.ts` — if `PAPER_ENFORCE_MODE === "paper"`, `PolyTraderWalletPort.resolve()` is never called and the live `PolymarketClobAdapter` is never constructed. Two failsafes, independent.
- **Test-mode fake sidecar**: `bootstrap/capabilities/AGENTS.md` Standards: "Test mode returns fake adapter-backed capability." When `APP_ENV=test`, `poly-trade-executor.ts` injects a `FakePaperAdapter` whose `placeOrder` / `getOrder` / `cancelOrder` return canned receipts — no IPC, no Python process. Lives in `nodes/poly/app/tests/_fakes/` (existing fakes directory). Mirrors the test/prod split already in `bootstrap/capabilities/`.

### Simplest implementation sketch

```
P0 lands in this order:
  1. spike — produce a 1-page integration-shape doc
  2. sidecar Dockerfile + image build CI
  3. PaperAdapter body wired to sidecar transport (Zod IPC)
  4. Executor dispatch on intent.mode + PAPER_ENFORCE_MODE override
  5. Schema: mode column on fills + decisions
  6. Bootstrap: read DB mode; plan-mirror routes paper to place
  7. Position aggregation reads paper from fills, not Data-API
  8. Test that ConditionResolution listener stamps paper rows

P1 lands after P0 is green on one prod target:
  9.  PAPER_ENFORCE_MODE=paper on candidate-a kustomization
  10. PAPER_ENFORCE_MODE=paper on preview kustomization
  11. Bootstrap belt-and-suspenders: refuse live CLOB creds when forced
```

P2 is polish — none of it is required for the loop to function.

## Design Review

> Critical /review-design pass. Goal: find problems, not confirm quality.

### Scorecard

| Dimension              | Verdict                 | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simplicity             | **PASS**                | One dispatcher in `poly-trade-executor.ts`, two pre-built `ClobExecutor` instances, one new container (sidecar), two new env vars (`PAPER_SIDECAR_HOST`, `PAPER_ENFORCE_MODE`), one new column (`mode` on fills + decisions), one new discriminator key (`attributes.mode` — zero schema lift). P0 is 8 small tasks; P1 is 2 VM provisions + 3 trivial config edits. No new ports, no `OrderIntent` shape change, no new repos. |
| OSS-First              | **PASS**                | `agent-next/polymarket-paper-trader` (MIT) is the engine. We write no fill logic. AGPL alternatives (`homerun`) explicitly rejected for license. Backtest-only alternatives (Nautilus) explicitly rejected for fitness.                                                                                                                                                                                                         |
| Architecture Alignment | **PASS**                | Hexagonal layering preserved (`MarketProviderPort`). Contracts-first (Zod-typed sidecar IPC). Pino logging through existing `loggerPort`. `EXECUTOR_SEAM_IS_PLACE_ORDER_FN`, `PLACEMENT_DISCRIMINATOR_IN_ATTRIBUTES`, `INSERT_BEFORE_PLACE`, `PLANNER_IS_PURE`, `CAP_COUNTS_REALIZED_ON_CANCEL`, `PRICE_TICK_NORMALIZED`, `MARKET_PROVIDER_SHAPE_FROZEN` all hold.                                                              |
| Boundary Placement     | **PASS**                | Sidecar transport client in `packages/market-provider/adapters/paper/` (PURE_LIBRARY, deps via constructor). Env reads (`PAPER_SIDECAR_HOST`, `PAPER_ENFORCE_MODE`) in `bootstrap/capabilities/poly-trade-executor.ts`. Sidecar k8s manifest in `infra/k8s/base/node-app/`. Sidecar image in `infra/images/poly-paper-sidecar/`. No package imports app/, no app imports services/.                                             |
| Content Boundaries     | **PASS**                | Project .md holds roadmap + design notes + design + review. Specs (As-Built) land when code does. Items (per task) hold execution. Research doc carries the OSS survey + open questions. No duplication.                                                                                                                                                                                                                        |
| Scope Discipline       | **PASS**                | Project explicitly defers: shadow-attribution, separate repo, fourth deployment, queue-position fidelity model. Run-phase items are explicit opt-ins on real-friction signals from P0/P1.                                                                                                                                                                                                                                       |
| Risk Surface           | **CONCERN (mitigated)** | Four risks identified and addressed below.                                                                                                                                                                                                                                                                                                                                                                                      |

### Risks identified

1. **Env-var typo routes a real order on a paper environment.** Mitigation in P1 task (`PAPER_ENFORCE_MODE=paper` ⇒ refuse to load CLOB credentials at all). Two independent failsafes.

2. **Sidecar crash mid-fill leaves a `pending` row forever.** Mitigation: same `OrderReconciler` as live; sidecar failure leaves row `pending` and times out per existing reconciler policy. Open question 3 in research doc (persist open paper orders for sidecar restart recovery) lands inside the P0 spike.

3. **Upstream `agent-next` fee formula drift.** Polymarket can change fees without warning. Mitigation: P2 CI smoke test pins a fixture and fails on drift. Defer-acceptable — impact is non-catastrophic.

4. **`filled_size_usdc` accuracy on paper rows (CAP_COUNTS_REALIZED_ON_CANCEL).** The paper adapter must populate `filled_size_usdc` on the OrderReceipt or our cap accounting drifts. Mitigation: `task.C` (`PaperAdapter` body) explicitly tests this against fake-sidecar fills with partial-fill cases. Without this test, cap-drift bugs only surface under live traffic.

### Blocking issues

**None.** Design is the simplest path that satisfies the strict constraints (OSS-only fill model, algorithm runs end-to-end). Approve for implementation.

### Non-blocking suggestions

- **Spec update lands with `task.D`**, not with the project: when the executor dispatcher merges, update `docs/spec/poly-copy-trade-execution.md` (or the trade-executor spec) to document `attributes.mode` as a new discriminator alongside `attributes.placement`. Marked as As-Built per the project's convention.
- **Pin upstream `agent-next` commit SHA in the sidecar Dockerfile from day one** — don't track `main`. Already in P0 spike scope.
- **Resolve open questions 1-3, 5 inside the P0 spike** (pod layout, transport choice, state recovery, reconciler integration) so they're settled before `task.C` lands.
- **Pre-P1 smoke test**: after P0 ships, run **one full live→paper→live cycle on a single production target** before flipping `PAPER_ENFORCE_MODE` across `candidate-a` and `preview`. Confirm decision audit, fill rows (with correct `filled_size_usdc`), redemption stamp, and Grafana paper-mode panel all show expected shapes. Human gate.

### What changed in this design pass

This section was rewritten after invoking `/design` properly. The pre-`/design` draft had these errors:

1. **Wrong discriminator placement.** Draft put `mode` directly on `OrderIntent`. `PLACEMENT_DISCRIMINATOR_IN_ATTRIBUTES` requires it in `attributes`. `OrderIntent.attributes` is already a passthrough record; zero schema lift.
2. **Wrong executor seam usage.** Draft branched inside a single `ClobExecutor`'s `placeOrder`. The simplest path that respects `EXECUTOR_SEAM_IS_PLACE_ORDER_FN` and gives clean metrics buckets is two pre-built `ClobExecutor` instances + dispatcher above.
3. **Missing `CAP_COUNTS_REALIZED_ON_CANCEL` consideration.** Draft glossed over `filled_size_usdc` population on paper rows. Now called out explicitly with a test gate.
4. **Missing `readSource` delegation.** Draft didn't say the `PaperAdapter` should use the live adapter for `getMarketConstraints` / `listMarkets`. `PaperAdapterConfig.readSource` is already in the P1 stub for this purpose — paper inherits real ticks + real min-size, which is required to exercise `PRICE_TICK_NORMALIZED`.
5. **Missing belt-and-suspenders mechanism detail.** Draft said "refuse to load live CLOB creds when paper is forced" but didn't specify where — now anchored at `PolyTraderWalletPort.resolve()` short-circuit in `buildExecutor()`.

### What changed in the design-review pass

After invoking `/review-design` properly, the review surfaced one **blocking** issue and several concerns. All of them are now reflected in the project doc above:

1. **B1 (FAIL → fixed): paper redemption is real work, not a verify task.** `features/redeem/` is funder-scoped and chain-truth-based (REAPER_QUERIES_CHAIN_TRUTH, REDEEM_REQUIRES_BURN_OBSERVATION). Paper positions have no funder and no on-chain footprint, so the existing pipeline physically cannot stamp them. The previous `task.H` ("verify the listener works for paper") was replaced with a real `task.H` that builds a parallel paper-redemption job watching `ConditionResolution` and stamping `poly_copy_trade_fills WHERE mode = 'paper'` rows.
2. **C1: intent-construction site clarified.** The planner returns `MirrorPlan`, not `OrderIntent`. `attributes.mode` is stamped in `mirror-pipeline.ts` at intent assembly time (see :901 for shape). Planner stays pure.
3. **C2: test-mode FakePaperAdapter added** to boundary placement. Lives in `nodes/poly/app/tests/_fakes/`. `APP_ENV=test` boots with the fake, not the real sidecar.
4. **C3: deploy-order constraint promoted.** `task.D` (executor dispatch) MUST land before `task.F` (bootstrap reads DB mode), or paper-mode targets emit decisions that hit the live CLOB. Recommend combining `task.D` + `task.E` + `task.F` into one PR. Added as an explicit constraint in the P0 section.
5. **C4: sidecar in production overlay** documented as intentional (per-target paper-in-prod is a P0 capability).
6. **C5: spec update timing**. `task.D`'s PR should also update `docs/spec/poly-copy-trade-execution.md` to document `attributes.mode` as a new discriminator alongside `attributes.placement`.
7. **C6: `OrderReceipt.filled_size_usdc` is non-optional** (`order.ts:141`). PaperAdapter must populate. Now an explicit acceptance criterion on `task.C`.
