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
- `production` continues as today, **live-only**. The original spec sketched a per-target `mode='paper'` trapdoor in PROD; that path was hardened out as `PAPER_DISPATCH_IS_ENV_ONLY` — see Current Status below.

The strict constraint is that **we write no fill logic**. The fill model lives in [`agent-next/polymarket-paper-trader`](https://github.com/agent-next/polymarket-paper-trader) (MIT). Strategy constraints — limit-orders-only and ride-to-redemption — eliminate the failure modes (SELL slippage, neg-risk SELL routing, market-order partial fills) that would otherwise force us to model matching engine behaviour. Realistic fidelity under these constraints: ~96-98%, irreducible gap is queue position at congested price levels.

## Current Status (2026-05-16)

PR1–PR3 of the original roadmap (below) shipped in PR #56 (merged to `main` as `fdbc11399`). Verified:

| Surface                                                 | State                                                                                                                                                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poly-test` (cand-a)                                    | `PAPER_ENFORCE_MODE=paper`. Sidecar running. 20 paper placements in last 1h against `swisstony` (verified via Loki).                                                                                                              |
| `poly-preview`                                          | `PAPER_ENFORCE_MODE=paper`. Sidecar running. Same envelope as cand-a, more stable (no per-PR rebuilds).                                                                                                                           |
| `poly` (PROD)                                           | Live trading. Sidecar NOT deployed. Per-target `mode='paper'` would fail today (no sidecar). Not yet needed.                                                                                                                      |
| `/api/v1/agent/register` (poly-test)                    | Live. Mints `cogni_ag_sk_v1_...` bearer + `billing_account_id`. **The AI-authable entry point.**                                                                                                                                  |
| `/api/v1/poly/copy-trade/{targets,targets/[id],orders}` | All accept bearer via `resolveRequestIdentity` (bearer-first, cookie fallback).                                                                                                                                                   |
| Multi-tenant data layer                                 | RLS enforced on `poly_copy_trade_{targets,fills,decisions,attribution}` per `billing_account_id`. Cross-tenant enumerator (`listAllActive`) does NOT dedupe by target_wallet — every tenant's row produces independent decisions. |

**In-flight PRs (2026-05-16):**

- **PR #60** — `mode='paper'` DB stamping (the `5b545b627` commit). Closes the gap where paper-enforced envs wrote `mode='live'` on every ledger row. **Superseded by the hardening PR below**, which also fixes the analytics gap and additionally rips out the per-target dispatch trapdoor.
- **Hardening PR (this branch, `derekg1729/paper-mode-env-only-dispatch`)** — establishes `PAPER_DISPATCH_IS_ENV_ONLY`. `PAPER_ENFORCE_MODE` is the sole switch that activates paper routing. Per-target `mode` column on `poly_copy_trade_targets` becomes pure advisory metadata (still stamped for analytics, no longer dispatched on). `intent.attributes.mode` retained for Loki visibility, ignored by the executor. Closes a latent trapdoor where a DB row with `mode='paper'` in PROD could (in theory, given a sidecar deployment) silently mis-route money-path placements to a paper sidecar.

**Real gaps blocking the next phase** (each verified against code, NOT speculation):

1. **`/copy-trade/orders` ignores tenant.** `nodes/poly/app/src/app/api/v1/poly/copy-trade/orders/route.ts:89` — `TODO(HARDCODED_USER)`. Calls `ledger.listRecent({limit, target_id})` with zero tenant scoping; every authenticated caller sees every tenant's ledger rows. This is the **#1 blocker for multi-tenant paper experimentation** because each agent must observe its own PnL, not the global pool. **A worktree subagent is closing this on `derekg1729/orders-route-tenant-scope` (separate PR).**
2. **~80% of paper orders show `status=cancelled` in cogni DB.** Reported in PR #56 handoff as bug #6, never investigated. Could be reconciler grace-window aging, could be a real sidecar/pm_trader bug. **Until diagnosed, no paper PnL number is trustworthy.**
3. **PROD has no paper sidecar.** With `PAPER_DISPATCH_IS_ENV_ONLY` in force, that's now by design — PROD is live-only and any `mode='paper'` target row there is advisory metadata only. If we ever want PROD shadow-paper later, it would require deploying the sidecar AND changing the env-only invariant (deliberate, not accidental).

**Routes that do NOT need to be built** (prior handoff claimed otherwise; verified false):

- `/api/v1/poly/copy-trade/config` — zero source references. `poly_copy_trade_config` table dropped in migration 0036. The two tunable knobs (`mirror_filter_percentile`, `mirror_max_usdc_per_trade`) already live on `poly_copy_trade_targets` and are already PATCH-able via `/copy-trade/targets/[id]`.
- Bearer auth on copy-trade routes — already wired. `auth: { getSessionUser }` aliases to `resolveRequestIdentity` (bearer-first). The "missing bearer support" claim came from a token-scope mistake (operator-domain token used against poly-domain; HMAC `AUTH_SECRET` is per-environment).

## Next Phase — MVP: Trustworthy Multi-Tenant Paper Experimentation

> The goal of paper trading is NOT just "place fake orders." It is to find a more profitable copy-trade config than Derek's current `swisstony p80 $15` real-money policy, _without burning real USDC during the search_. Every part of this MVP is in service of that.

### Outcome

Within 2 weeks, we have:

1. **A trust anchor** — a paper-mode agent on `preview` running Derek's exact PROD config (`swisstony, mirror_filter_percentile=80, mirror_max_usdc_per_trade=15`), whose daily PnL tracks Derek's PROD PnL within ±X% over a rolling window. Trust score is reviewable on the dashboard.
2. **N concurrent experimental agents** — each a separate `billing_account_id` on `preview`, each with one (target, percentile, max_usdc) triple. Each agent's PnL is observable in isolation. Comparison ranks them against the trust anchor.
3. **A clean promotion path** — winning config → manual PATCH to Derek's PROD `copy_trade_targets` row → live capture of the alpha. No re-arch needed; the same DB row, same enumerator, same executor.

### Plan

**Phase 0 — Unblock observability + harden the dispatcher (2 PRs).** Don't run any experiments until both land.

| #   | Deliverable                                                                                                                                                                                                                                                                                               | Status                        | Files                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1 | `mode='paper'` DB stamping + hardened env-only dispatch (`PAPER_DISPATCH_IS_ENV_ONLY`). Removes the per-target trapdoor in `buildExecutor`; collapses `getOrder`/`cancelOrder` to live-only. Adds a regression test asserting `intent.attributes.mode='paper'` does NOT alter routing. Supersedes PR #60. | in flight — this branch       | `bootstrap/container.ts`, `bootstrap/capabilities/poly-trade-executor.ts`, `features/copy-trade/{plan-mirror,mirror-pipeline}.ts`, executor test |
| 0.2 | Close `HARDCODED_USER` on `/copy-trade/orders`. Scope to `sessionUser`'s `billing_account_id`. Add `mode` to response shape. Add a `mode=paper\|live\|all` query param (default `all`). Mirror the pattern from `/targets` route's `withTenantScope`.                                                     | in flight — worktree subagent | `nodes/poly/app/src/app/api/v1/poly/copy-trade/orders/route.ts` + contract                                                                       |
| 0.3 | Audit other ledger-reading routes for the same gap (`/wallet/execution`, `/wallet/overview`, `/internal/sync-health`, etc). File bugs for any that leak.                                                                                                                                                  | not started                   | grep `HARDCODED_USER` — known list above                                                                                                         |
| 0.4 | Diagnose the 80% cancel rate. Run the kubectl-pg-pod query against cand-a `poly_copy_trade_fills WHERE mode='paper'` after 0.1 lands. Decide: reconciler grace-window tuning, sidecar OrderState bug, or pm_trader behavior. **Cannot trust paper PnL until known.**                                      | not started                   | likely `features/redeem/`, `infra/images/poly-paper-sidecar/server.py`, or both                                                                  |

**Phase 1 — Establish the trust anchor (no code; ~1 day to set up + 1 week to observe).**

| #   | Action                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | `curl POST https://poly-preview.cognidao.org/api/v1/agent/register -d '{"name":"trust-twin-swisstony"}'`. Save the bearer + `billing_account_id`.                                                                                                                                     |
| 1.2 | `POST /copy-trade/targets` with `target_wallet=0x204f72…` (swisstony). PATCH the returned `target_id` with `mirror_filter_percentile=80, mirror_max_usdc_per_trade=15`. Identical to Derek's PROD config.                                                                             |
| 1.3 | Daily comparison: PROD swisstony PnL (from Derek's tenant ledger on `poly.cognidao.org`) vs preview trust-twin PnL (from the bearer's tenant ledger on `poly-preview.cognidao.org`). Both poll the same external target → same fills → comparable.                                    |
| 1.4 | Track divergence in a memo. Expected divergence: bid/ask spread + queue position (the irreducible ~2-4% fidelity gap). If actual divergence is >10% in either direction, halt and investigate. Likely culprits: cancel-rate bug, mode-stamp bug, sidecar fill-loop, neg-risk markets. |

**Phase 2 — Multi-tenant experimentation (no code beyond Phase 0; ~ongoing).**

Once the trust twin is calibrated:

| #   | Action                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | For each experimental config: register a new agent, POST the target(s), PATCH the knobs. One config = one tenant. Knob space today: `mirror_filter_percentile ∈ {50, 75, 80, 90, 95, 99}` × `mirror_max_usdc_per_trade ∈ {5, 15, 30}` × `target_wallet ∈ {swisstony, RN1}`. |
| 2.2 | Daily PnL ranking across tenants. Trust-twin tenant is the baseline. Any tenant outperforming by >10% sustained over 5 days is a promotion candidate.                                                                                                                       |
| 2.3 | Promotion = PATCH Derek's PROD target row to the winning config. The data layer already isolates everything; no rollout work.                                                                                                                                               |

**Phase 3 — Knob expansion (only if Phase 2 hits a ceiling; needs research, not coding-first).**

Knobs currently hardcoded in `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts`:

- pXX ladder values for swisstony / RN1 (the actual dollar thresholds at p50/p75/p90/p95/p99 — captured 2026-05-03, may be stale)
- Position-followup defaults: `min_mirror_position_usdc`, `market_floor_multiple`, `min_target_hedge_ratio`, `max_hedge_fraction_of_position`, `max_layer_fraction_of_position`
- Sizing-policy dispatch by wallet (`sizingPolicyKindForTargetWallet`)

If experimentation in Phase 2 shows these are the binding constraints, promote each to a per-target DB column + PATCH-route field. Each is a migration + 1 line in `buildMirrorTargetConfig`. **Do not preemptively promote knobs — let experimental signal drive what gets DB-backed.**

**Phase 4 — `/delta-minimizer` spikes against paper.** Once Phase 2 produces a config that beats trust-twin but differs from swisstony's apparent positioning, run `/delta-minimizer` on individual markets to understand WHY the config wins (or surfaces a bug). This is the loop the user named as "many delta-minimizer research spikes."

### Why this MVP is the pareto optimum

- **Zero new infra.** Sidecar, multi-tenant DB schema, bearer auth, RLS, agent-register — all already exist.
- **Zero new auth code.** `resolveRequestIdentity` already does bearer + cookie. Per-tenant scoping needs ONE route fix (`/orders`), not a re-architecture.
- **PROD untouched, hardened.** `PAPER_DISPATCH_IS_ENV_ONLY` removes the latent per-target trapdoor. Paper-trust validation happens entirely on `preview` because both PROD and preview observe the same external target wallet — no PROD-side paper sidecar needed.
- **Failure-mode aware.** Phase 0.4 (cancel-rate diagnosis) is mandatory before any experiment — without it the trust anchor itself is unreliable.
- **Future-proofed against accidental paper-routing.** Adding paper alongside live in PROD now requires an explicit env-flag change + sidecar deployment, not just a DB column flip. Both gates have to fail open at the same time.

### What this MVP explicitly does NOT include

- Building `/copy-trade/config` route. Non-existent. Doesn't need to exist.
- Adding bearer auth code. Already shipped.
- Deploying paper sidecar to PROD. Not required for the trust-validation path chosen here.
- Per-target paper-mode dispatch in `buildExecutor`. **Hardened out** as `PAPER_DISPATCH_IS_ENV_ONLY` — see in-flight PRs above.
- New "AI agent identity" abstractions beyond the existing `users + billing_accounts + bearer keys` triple.
- A "shadow account" auto-mirroring abstraction. Manual config-mirroring on the trust anchor is sufficient for v0; auto-mirror is friction for future Derek.

## Roadmap

> **Original PR1–PR3 plan below is preserved for historical context. All three shipped in PR #56 (merged `fdbc11399`).** The "Status" checkboxes were never ticked because the work moved to a single combined PR, but the design notes that follow are the as-built spec.

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

#### PR 3 — Upstream-engine wiring (functional paper trading)

PRs 1 + 2 ship the **architecture** for paper trading: the TS dispatcher routes paper-mode intents through `PaperAdapter`, the sidecar runs in candidate-a + preview, and `PAPER_ENFORCE_MODE=paper` is set. But the sidecar's `server.py` is a v0 placeholder — Run-phase endpoints return 501. **No actual paper fills happen.** PR 3 replaces the placeholder with a thin FastAPI wrapper over `agent-next/polymarket-paper-trader`'s `pm_trader` library. After PR 3, every existing trade pathway (`planMirrorFromFill` → ledger insert → executor dispatch → `PaperAdapter` → sidecar) produces real simulated fills against the live Polymarket book.

**Scope is constrained by the same constraints as PRs 1+2:** we write no fill logic. The sidecar is HTTP transport + Zod-compatible response shaping. All matching, fee math, and book-walk logic lives in the pinned upstream commit.

**Touched layer:** `infra/images/poly-paper-sidecar/**` only. Zero TS changes. Zero overlay changes. Single-image rebuild via `build-poly-paper-sidecar.yml`, then bump the digest in candidate-a + preview overlays (Shape 2 manual bump path; Gap 1 of `docs/guides/create-service.md`).

**Hard ordering:** item 1 (Dockerfile install) gates everything; item 7 (background fill loop) gates 6 (`getOrder` returning fills); item 8 (smoke fixture) is the merge gate proving the wiring actually fills an order against a recorded book.

| #   | Deliverable                                                                                                                                                                                                                                                                                           | Status | Files                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| 1   | Pin + install `agent-next/polymarket-paper-trader` in the sidecar Dockerfile — `pip install git+https://github.com/agent-next/polymarket-paper-trader@<sha>` under the `UPSTREAM_PAPER_TRADER_SHA` build arg. Audit the fee formula and `orders.py` API before each bump.                             | [ ]    | `infra/images/poly-paper-sidecar/Dockerfile`                                              |
| 2   | FastAPI lifespan: open `Database` connection, instantiate `Engine`, start fill-poll background task; on shutdown gracefully cancel + close. Single global `asyncio.Lock` guards every Engine call (SQLite WAL gives concurrent reads; our writes serialize).                                          | [ ]    | `infra/images/poly-paper-sidecar/server.py`                                               |
| 3   | `POST /place-order` — Zod-shaped request body → `engine.place_limit_order(slug, outcome, side, amount, price)` via `asyncio.to_thread` under the lock → map `LimitOrder` → `OrderReceipt` (`status="open"`, `filled_size_usdc=0`, `submitted_at=created_at`). Echo `client_order_id` for correlation. | [ ]    | `infra/images/poly-paper-sidecar/server.py`                                               |
| 4   | `POST /orders/{order_id}/cancel` — `orders.cancel_order(conn, order_id)` under lock. Return 204 on cancel, 404 if not found (TS adapter swallows 404 as idempotent).                                                                                                                                  | [ ]    | `infra/images/poly-paper-sidecar/server.py`                                               |
| 5   | `GET /orders/{order_id}` — `orders.get_order(conn, order_id)` under lock. 200 with `OrderReceipt` mapped from `LimitOrder` state (status maps `pending`→`open`, `filled`→`filled`, etc.; `filled_size_usdc` populated from upstream when filled). 404 if not found (TS adapter returns `not_found`).  | [ ]    | `infra/images/poly-paper-sidecar/server.py`                                               |
| 6   | Background fill-poll task — every `PAPER_CHECK_ORDERS_INTERVAL_SECONDS` (default 10s), call `engine.check_orders()` under the lock. This is the only mechanism by which a resting paper limit ever fills; without it, `getOrder` always returns `status="open"`.                                      | [ ]    | `infra/images/poly-paper-sidecar/server.py`                                               |
| 7   | `/readyz` + `/version` endpoints per Shape 1 conventions. `/readyz` opens a DB connection round-trip + verifies `engine.api` is live; `/version` returns `{ buildSha, upstreamPaperTraderSha, builtAt }` so `/validate-candidate` can prove the deployed sidecar matches expectations.                | [ ]    | `infra/images/poly-paper-sidecar/server.py`, `infra/images/poly-paper-sidecar/Dockerfile` |
| 8   | Pinned-fixture smoke test — record one Polymarket order-book snapshot; place a limit at a price that the recorded book would fill; assert `engine.check_orders()` marks it filled with the expected `filled_size_usdc` (within fee-formula tolerance). Runs in pr-build for the sidecar image.        | [ ]    | `infra/images/poly-paper-sidecar/tests/test_fill_against_fixture.py` (new)                |
| 9   | Bump candidate-a + preview overlay sidecar digests to the new build's `sha-<short>` (manual Shape 2 bump, separate commit on `main` per Gap 1). Verify pod restart and `/version` flips.                                                                                                              | [ ]    | `infra/k8s/overlays/{candidate-a,preview}/poly/kustomization.yaml`                        |
| 10  | Update `infra/images/poly-paper-sidecar/AGENTS.md` — drop the "501 placeholder" language; document the upstream-pin audit checklist (fee formula, `orders.py` signature changes, schema migrations between SHAs); link to the smoke fixture as the drift detector.                                    | [ ]    | `infra/images/poly-paper-sidecar/AGENTS.md`                                               |

**Definition of done:** one mirror placement under `mode='paper'` on a real candidate-a flight produces a `poly_copy_trade_fills` row with `filled_size_usdc > 0`, sourced from a sidecar fill against the live Polymarket book. The same code path (`planMirrorFromFill` → `mirror-pipeline.ts` → `poly-trade-executor.ts` → `PaperAdapter` → sidecar) runs identically to live, with only the final `placeOrder` swapped — the user's stated goal.

**Out of scope for PR 3:**

- **Paper-redemption job** (PR 1 roadmap item 10) — the on-chain `ConditionResolution` listener stamps paper rows when underlying markets resolve. Separate workstream; the sidecar is uninvolved.
- **PVC for sidecar SQLite** — v0 ships ephemeral. Pod restart loses open paper orders; the reconciler treats them as orphans (same code path as a CLOB outage). Add only if preview's restart cadence produces real friction.
- **Multi-account isolation in the sidecar** — single `PM_TRADER_ACCOUNT=cogni-paper` per pod. Per-target paper bucketing is already done in our Postgres via `mode` + `target_id` on fill rows.
- **`argocd-image-updater` annotations** for sidecar auto-bump (Gap 1) — separate operator-domain PR.
- **CI fee-drift smoke** in the cogni-poly repo's CI (existing polish item) — the in-image smoke (item 8) is the load-bearing version for PR 3; the cross-repo CI smoke is still a polish item.

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

## Design — PR 3 (Upstream-Engine Wiring)

> Distinct `/design` pass for the sidecar implementation. The original design (above) covered the TS architecture + deploy topology and pre-committed the sidecar as a process boundary. This pass picks up after that decision and resolves how the FastAPI wrapper actually maps onto `pm_trader`'s API.

### Refined outcome for PR 3

_"Every paper-mode placement that exits `mirror-pipeline.ts` produces a row in the sidecar's SQLite, gets evaluated against the live Polymarket book by `engine.check_orders()` running on a 30s background poll, and surfaces its fill state back through `getOrder` polling such that the cogni reconciler stamps `poly_copy_trade_fills.status = 'filled'` + `filled_size_usdc > 0` without any code in this repo touching fill logic, fee math, or book-walk simulation."_

### Upstream surface area (audited at v0.1.6 / commit `8a0a3ee2`)

`agent-next/polymarket-paper-trader` is sync Python with SQLite (WAL) persistence at `${PM_TRADER_DATA_DIR}/${PM_TRADER_ACCOUNT}/`. The surface we depend on:

- `pm_trader.engine.Engine(data_dir: Path)` — orchestrator. Single instance per pod. Methods we call:
  - `init_account(balance: float)` — idempotent at startup.
  - `place_limit_order(slug_or_id, outcome, side, amount, limit_price, order_type="gtc", expires_at=None) -> dict`
  - `cancel_limit_order(order_id: int) -> dict | None` (`None` when not found or not pending)
  - `check_orders() -> list[dict]` — returns the dicts of orders that filled THIS call
  - `close() -> None`
- `pm_trader.api.PolymarketClient.get_market(slug_or_id)` accepts both slug and condition_id (basis for our market-identity translation; see next subsection).
- CLI + MCP layers are built on Engine; we skip them entirely.

**Engine methods return `dict`, not the `LimitOrder` dataclass.** The dict shape is upstream-version-coupled, so the sidecar uses defensive `.get()` access on the keys it needs (`id`, `status`, `created_at`) and stores the raw dict for forward-compat surfacing in `attributes`.

Confirmed contracts:

- `Engine.check_orders()` is the **only** way a resting limit transitions to filled. No callback, no WS, no internal background loop. **Our background poll thread is load-bearing** — without it, all paper orders are forever-pending.
- Upstream status ∈ `{pending, filled, cancelled, expired}`. Maps to cogni `OrderStatus`: `pending → "open"`, `filled → "filled"`, `cancelled/canceled/expired → "cancelled"` (reconciler treats expired identically to cancelled).

### Market identity translation

Cogni `market_id` is shaped `"prediction-market:polymarket:<conditionId>"` (per [`polymarket.normalize-fill.ts:79`](../../nodes/poly/packages/market-provider/src/adapters/polymarket/polymarket.normalize-fill.ts)). The sidecar strips the prefix and passes the bare conditionId to `Engine.place_limit_order(slug_or_id=...)`. Fallback: if the prefix is absent, use `intent.attributes.condition_id` if present. Last resort: pass `market_id` through verbatim and let upstream 4xx.

### Fee model + `filled_size_usdc` (v0 convention)

Upstream `simulate_*_fill` returns a `FillResult` with **GROSS** `total_cost` / `total_shares` (pre-fee) and a separate `fee` field. Net realised notional is `total_cost - fee`.

**v0 simplification:** the sidecar sets `filled_size_usdc = intent.size_usdc` on full fills (`status="filled"`), and `0` otherwise. This is a documented over-statement vs. the strict net realised amount, accepted for v0 because:

1. Under copy-trade cap sizes ($1-50/trade), full fills against deep books dominate.
2. Upstream's check_orders dict doesn't yet stably expose the per-order realised-cost/fee fields we'd need across upstream SHAs.
3. Cap accounting (`CAP_COUNTS_REALIZED_ON_CANCEL`) compares against `intent.size_usdc` — using `size_usdc` here doesn't drift the gate.

Partial-fill fidelity (`filled_size_usdc < intent.size_usdc`) is a follow-up once upstream stabilises the dict keys.

### Logging

JSON-ish single line to stdout, Alloy → Loki pickup. Each line carries `event=<verb>` + `client_order_id=<id>` so Grafana queries can join sidecar logs to cogni Pino logs on the same `client_order_id`. Required `event` verbs: `sidecar_started`, `order_placed`, `order_filled`, `order_cancelled`, `place_failed`, `cancel_failed`, `check_orders_failed`. The cogni-side adapter (`PaperAdapter`) already carries `client_order_id` through every request; the sidecar just has to log it back.

### Invariants extracted (TS-side, must hold through PR 3)

Loaded from `nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts`, `nodes/poly/packages/market-provider/src/domain/order.ts`, `docs/spec/poly-copy-trade-execution.md`.

- `PAPER_POPULATES_FILLED_USDC` (paper.adapter.ts:20) — receipt `filled_size_usdc` must reflect the sidecar's realised fill amount. PR 3 must map `LimitOrder.amount × fill_price` (post-fee) into this field on `getOrder` of a filled order. **Without correct mapping, `CAP_COUNTS_REALIZED_ON_CANCEL` accounting drifts on paper.**
- `PAPER_GETORDER_NEVER_NULL` (paper.adapter.ts:23) — sidecar must respond 404 (not 200 with null) when an order is absent. TS adapter discriminates on 404. PR 3 maps `get_order` returning `None` → 404.
- `PAPER_DELEGATES_READS_TO_LIVE` (paper.adapter.ts:17) — `listMarkets` + `getMarketConstraints` go through the TS-side `readSource`, NOT through the sidecar. The sidecar never serves these. Don't add endpoints for them.
- `MARKET_PROVIDER_SHAPE_FROZEN` (paper.adapter.ts) — the TS HTTP contract is fixed. PR 3 must conform to the existing endpoint shapes (paths, methods, status codes); changing the contract requires also changing the TS adapter, which is out of scope.
- `IDEMPOTENT_BY_CLIENT_ID` (copy-trade/AGENTS.md) — same `client_order_id` must not double-place. `pm_trader.orders.create_order` generates a fresh upstream id per call; the sidecar must **not** dedupe by `client_order_id` on its side (the TS ledger is the dedupe gate via `INSERT_BEFORE_PLACE`). The receipt echoes `client_order_id` for correlation — that's all.
- `INSERT_BEFORE_PLACE` (mirror-pipeline.ts:10-11) — `insertPending()` runs before `executor()`. A sidecar failure mid-place leaves a `pending` ledger row that the reconciler handles. PR 3 must surface clean HTTP errors (timeouts, upstream-down, DB-locked) so the TS adapter throws and the reconciler observes a `pending → unknown` transition rather than a silent ledger desync.
- `PRICE_TICK_NORMALIZED` (copy-trade/AGENTS.md) — `getMarketConstraints` is called pre-place on the TS side. The sidecar receives an already-ticked `limit_price`; passing it through to `engine.place_limit_order` is sufficient.

### Three approaches considered

**Approach A — In-process Python wrapper around `Engine` (chosen).** FastAPI lifespan instantiates `Engine` once. Handlers are sync `def` (run in FastAPI's internal threadpool — no asyncio plumbing). A single global `threading.Lock` guards every Engine call. A daemon `threading.Thread` wakes every `PAPER_CHECK_ORDERS_INTERVAL_SECONDS` and calls `engine.check_orders()` under the same lock. One Python process, one SQLite file.

- Pros: simplest. No subprocess management, no IPC marshalling, no MCP transport. Uses upstream as a library (the documented embedding path). Smallest delta from current placeholder. Sync handlers + threading match `Engine`'s own sync design — no async↔sync bridge anywhere.
- Cons: a slow `check_orders()` (many open orders × many book fetches) blocks place/cancel for its duration. **Mitigation:** SLO is 30s background period + sub-second per-order fetch; <50 concurrent open paper orders is the realistic ceiling under copy-trade cap sizes.

**Approach B — Subprocess `pm-trader` CLI per call.** Each `/place-order` shells out to `pm-trader place-limit ...`; output parsed. State lives in the same SQLite via the CLI.

- Pros: CLI is the documented stable surface; insulates us from `pm_trader.engine` API drift.
- Cons: CLI is designed for human use — colour codes, currency formatting, output stability is not promised across upstream releases. Parsing it from a service is brittle and silently breaks on next bump. (Subprocess latency is irrelevant at our v0 cap-size traffic.) **Reject.**

**Approach C — MCP stdio server (`pm-trader-mcp`) under the FastAPI process.** Run `pm-trader-mcp` as a subprocess; speak MCP over its stdio; expose HTTP endpoints that translate.

- Pros: MCP is the project's documented agent-facing interface.
- Cons: MCP transport is a heavy stack for a single-pod loopback IPC. Adds a stdio supervisor, a JSON-RPC client, framing concerns. No benefit over direct import. **Reject.**

**Choose Approach A.** Direct import is the smallest, most legible, and most consistent with how `pm_trader` is documented to be embedded. The single global lock is a feature, not a workaround.

### Concurrency + persistence model

- **One `threading.Lock` for the entire Engine.** All endpoint handlers + the background fill thread acquire it before calling any `engine.*` method. SQLite WAL allows concurrent reads but our writes serialize through one lock at the Python-object level — where it actually matters.
- **FastAPI handlers are sync `def`, not `async def`.** Starlette runs sync handlers in its internal threadpool, so each request gets its own thread that competes for the lock. No `asyncio.to_thread`, no async-vs-sync bridge. Liveness/`/healthz` is sync and lock-free, so it stays answerable even mid-`check_orders` — k8s probes never trip under load.
- **Background fill loop is a daemon `threading.Thread`** started in lifespan, signaled via a `threading.Event`. Loop body: `event.wait(period)` → acquire lock → `engine.check_orders()` → release. Daemon=True ensures the process can exit cleanly even if the join hangs.
- **SQLite at `${PM_TRADER_DATA_DIR}/${PM_TRADER_ACCOUNT}/`** (default `/tmp/pm_trader/cogni-paper`). v0: container-fs, ephemeral, /tmp-compatible with `readOnlyRootFilesystem: true`. v1 (gated on signal): mount a PVC. Pod restart drops open paper orders → TS adapter's next `getOrder` returns 404 → reconciler closes the orphan pending. Matches the live failure mode for a CLOB outage. Acceptable for v0.
- **Account starting balance** `PM_TRADER_STARTING_BALANCE_USDC=1000000` (1M). Upstream cap-rejection never fires; cogni's own cap-enforcement is the gate. Sidecar account balance is meaningless for paper-PnL bookkeeping (we use `poly_copy_trade_fills WHERE mode='paper'` for that); set high, ignore.

### Request/response mapping

`POST /place-order` request → upstream:

```
{ client_order_id, market_id, token_id?, outcome, side, size_usdc, limit_price, attributes? }
                                  ↓
PolymarketClient.get_market(market_id)         # accepts conditionId or slug
  → resolves slug + condition_id for upstream
                                  ↓
Engine.place_limit_order(
  slug=<resolved>,
  outcome=<from request>,
  side=<BUY|SELL>,
  amount=<size_usdc>,
  price=<limit_price>,
)
  → returns LimitOrder
                                  ↓
OrderReceipt {
  order_id: limit_order.id,
  client_order_id: <echo>,
  status: "open",                    # always — fills only on next check_orders
  filled_size_usdc: 0,               # always — see above
  submitted_at: limit_order.created_at.isoformat(),
  attributes: { upstream_status: limit_order.status, slug: <resolved> },
}
```

`GET /orders/{id}` → upstream:

```
orders.get_order(conn, order_id)
  → LimitOrder | None
                                  ↓
None → HTTP 404 (TS adapter → { status: "not_found" })
LimitOrder → OrderReceipt {
  order_id, client_order_id: limit_order.client_order_id_echoed,
  status: STATUS_MAP[limit_order.status],
  filled_size_usdc:
    limit_order.status == "filled" ? limit_order.amount * limit_order.fill_price : 0,
  submitted_at, attributes: { upstream_status, fill_price?, filled_at? },
}
```

`POST /orders/{id}/cancel` → upstream:

```
orders.cancel_order(conn, order_id)
  → LimitOrder | None
                                  ↓
None → HTTP 404
LimitOrder → HTTP 204
```

### Background fill loop semantics

```python
def _fill_loop(self) -> None:
    while not self._stop.wait(CHECK_ORDERS_INTERVAL_SECONDS):
        try:
            with self.lock:
                filled = self.engine.check_orders()
            for d in filled:
                # update OrderState[d["id"]] → status="filled"
                ...
        except Exception as e:
            log.exception(f"event=check_orders_failed err={e}")
```

Key properties:

- **Period 30s default.** Aligned to half the cogni reconciler's tick (`order-reconciler.job.ts:81` — `RECONCILE_POLL_MS = 60_000`): a fill is at-most-30s stale when reconciler asks. Smaller = faster fill detection but more book-fetch load + Polymarket public-API exposure. Range 5–60s; tunable via env.
- **No catch-up.** A missed cycle is just a missed cycle — `engine.check_orders` always reads current book. We never replay historical states.
- **Loop never exits.** A raised exception logs + continues. Stops only at shutdown (`_stop` event set in lifespan teardown). If `engine.check_orders` throws every iteration, `/readyz` reports `fill_loop_not_running` only when the thread itself dies — a permanently-throwing loop body is detected via a Grafana alert on `mode='paper'` fill-rate-drop (separate workstream).
- **`/readyz` watches the thread.** The endpoint asserts `sidecar._fill_thread.is_alive()`; if the thread crashes (not just an iteration throwing), `/readyz` flips 503 → k8s restarts the pod.

### Boundary placement

- **Sidecar Python lives in `infra/images/poly-paper-sidecar/`** (already there). No new directories.
- **Smoke test** at `infra/images/poly-paper-sidecar/tests/test_fill_against_fixture.py`. Recorded book fixture as a sibling JSON. Runs in pr-build for the sidecar image (extend `build-poly-paper-sidecar.yml` to invoke `pytest` after the build, before the push).
- **No new TS code.** The PaperAdapter contract already covers everything PR 3 exposes.
- **No new env vars in the cogni-poly app** (TS side). New env vars are sidecar-internal: `PM_TRADER_DATA_DIR`, `PM_TRADER_ACCOUNT`, `PM_TRADER_STARTING_BALANCE_USDC`, `PAPER_CHECK_ORDERS_INTERVAL_SECONDS`, `UPSTREAM_PAPER_TRADER_SHA` (build-time). Set as Dockerfile `ENV` defaults; overridable via the kustomize container patch's `env:` block if a per-env tuning need arises (none anticipated for v0).

### Operational story end-to-end

1. AI agent opens a PR touching `nodes/poly/app/src/features/copy-trade/**`. Existing code; nothing about it knows or cares that paper exists.
2. Candidate-flight publishes the new cogni-poly image; the sidecar (v3.0) is already running with its background fill loop.
3. Mirror tick fires. `planMirrorFromFill` decides `kind="place"` with `attributes.mode="paper"` (forced by `PAPER_ENFORCE_MODE=paper` on candidate-a regardless of target's DB mode).
4. `mirror-pipeline.ts` calls `insertPending()` (cogni Postgres row with `status='pending'`, `mode='paper'`), then `executor(intent)`. The executor dispatcher routes to the paper `ClobExecutor`, whose `placeOrder` calls `PaperAdapter.placeOrder` → HTTP `POST /place-order` to the sidecar.
5. Sidecar returns `OrderReceipt` with `status="open"`, `filled_size_usdc=0`. Cogni Postgres row updated to `status='open'`, `order_id=<sidecar id>`.
6. 0-30s later, sidecar's fill loop runs `check_orders()`. The recorded limit crosses the live Polymarket ask book. The sidecar's in-memory `OrderState` flips to `status="filled"` with `filled_size_usdc = intent.size_usdc` (v0 full-fill convention).
7. Next reconciler tick (≤60s later): cogni calls `PaperAdapter.getOrder(<sidecar id>)` → HTTP `GET /orders/<id>` → sidecar returns `OrderReceipt` with `status="filled"`, `filled_size_usdc=<intent_size_usdc>`. Cogni updates the row.
8. Eventually, the market resolves on-chain. The `ConditionResolution` listener (live mode's listener, unchanged) emits an event. The paper-redemption job (PR 1 item 10, separate workstream from PR 3) stamps `poly_copy_trade_fills.position_lifecycle="redeemed"` on the paper row.

The user's goal — "all of our existing trade + db logic pathways are used, but instead of using the polymarket real adapter for making + redeeming positions, we use the paper trader adapter" — is satisfied at step 4-7 for placement, and at step 8 for redemption. **The redemption pathway uses the on-chain listener exactly as live mode does**; there is no separate "paper redemption" adapter because there is no fill-side simulation required for redemption (it's a chain event, ground truth).

## Design Review — PR 3

> Critical `/review-design` pass. Goal: find problems with the PR 3 design, not confirm quality.

### Scorecard

| Dimension              | Verdict                 | Rationale                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simplicity             | **PASS**                | One Python file (`server.py`) gains ~150 lines. One Dockerfile gains a `pip install`. No new directories. Zero TS changes. Single global lock, one background task. The smoke fixture is one recorded JSON + one pytest file. PR 3 is the smallest possible delta from "501 placeholder" to "functional paper trading."                                                                            |
| OSS-first              | **PASS**                | `pm_trader.Engine` is imported and called as-is. No fill logic, no fee math, no book-walk written by us. Bumping `UPSTREAM_PAPER_TRADER_SHA` is the only paper-engine update path. Smoke fixture (item 8) is the drift detector.                                                                                                                                                                   |
| Architecture Alignment | **PASS**                | The PaperAdapter contract is unchanged. `PAPER_POPULATES_FILLED_USDC`, `PAPER_GETORDER_NEVER_NULL`, `PAPER_DELEGATES_READS_TO_LIVE`, `MARKET_PROVIDER_SHAPE_FROZEN`, `IDEMPOTENT_BY_CLIENT_ID`, `INSERT_BEFORE_PLACE`, `PRICE_TICK_NORMALIZED` all hold. The sidecar boundary respects `PURE_LIBRARY` on the TS adapter (no env reads added to the adapter; sidecar config is via Dockerfile ENV). |
| Boundary Placement     | **PASS**                | Sidecar entirely contained in `infra/images/poly-paper-sidecar/`. No imports into TS code, no shared types. The TS adapter speaks HTTP only — no Python coupling. Smoke test lives next to the sidecar, runs in the sidecar's build pipeline, not in pr-build for the TS app.                                                                                                                      |
| Content Boundaries     | **PASS**                | PR 3 design + review live in this project doc (continues the project's content boundary convention). The sidecar's `AGENTS.md` gets a refresh (item 10) but stays scoped to "what this directory does." No new spec files. No duplicate prose.                                                                                                                                                     |
| Scope Discipline       | **PASS**                | Explicitly defers: PVC, multi-account, argocd-image-updater wiring, fee-drift CI smoke in cogni-poly repo. Each is gated on a real friction signal, not anticipated need.                                                                                                                                                                                                                          |
| Risk Surface           | **CONCERN (mitigated)** | Five risks identified, mitigations in line. None are blocking; all are visible.                                                                                                                                                                                                                                                                                                                    |

### Risks identified

1. **`engine.check_orders()` blocks all place/cancel for its duration.** Single global lock + `to_thread` means a long fill cycle stalls placement requests. **Mitigation:** copy-trade cap sizes are small (~50 concurrent open paper orders ceiling); `check_orders` is sub-second per order in upstream's documented profile. Re-architect to a per-order lock or a write-skew tolerant design only if/when concurrent-order count rises past 50. Visible via a Grafana panel on sidecar request latency p95.
2. **Pod restart drops all open paper orders.** Acceptable per v0 design (reconciler handles orphans), but the operational reality on preview is that day-bridge limit orders never get a chance to fill across a redeploy. **Mitigation:** document the cadence; if preview's deploy frequency drops fill-rate visibly, mount a PVC (1-line overlay change + 2-line Dockerfile env change). Don't pre-build the PVC path.
3. **Market-identity mismatch.** `PolymarketClient.get_market(slug_or_id)` accepts both but its resolution behaviour for conditionId-only inputs depends on the upstream's market-search cache. If a thinly-traded market isn't cached, the call may fail. **Mitigation:** smoke fixture (item 8) must cover a freshly-discovered conditionId, not just a well-known slug. Audit at each upstream bump.
4. **Fee formula drift between upstream SHAs.** Polymarket can change fees; upstream may lag. **Mitigation:** item 8 fixture asserts a specific `filled_size_usdc` against a known fill scenario. Bumping the pin without re-blessing the fixture fails the build. The cross-repo fee-drift CI smoke (existing polish item) remains the longer-horizon safety net.
5. **Background loop silently stops.** If the lifespan task gets cancelled or the loop body raises in a way that escapes the catch, no fills happen but `/readyz` still passes. **Mitigation:** `/readyz` checks `app.state.fill_loop_task.done() is False` in addition to DB liveness; lifespan teardown is the only legitimate way the task should be done.

### Blocking issues

**None.** The design is the smallest path that satisfies the user's stated goal (all existing trade+db pathways used, paper adapter swaps in for placement). Risks are visible and have visible mitigations.

### Non-blocking suggestions

- **Pin the upstream SHA in PR 3 itself, not as a follow-up.** Choose a known-good commit before merging the Dockerfile change. Don't ship `UPSTREAM_PAPER_TRADER_SHA=main`.
- **Run the smoke fixture in the sidecar build workflow's failure-blocking step**, not as a passive log. CI red ⇒ no image push.
- **`/version` endpoint should return both `buildSha` (our sidecar build) and `upstreamPaperTraderSha`** so `/validate-candidate` can prove drift detection at-a-glance.
- **Background loop period should be env-tunable but bounded.** Document the range `5-60s` and the rationale (lower bound = book-fetch rate-limit risk; upper bound = fill-detection latency exceeds reconciler tick). Default 30s (half the cogni reconciler's 60s tick).
- **The "single mirror placement produces a paper fill on candidate-a" gate (DoD)** should be captured as a `/validate-candidate` scorecard row before PR 3 merges, so the next agent doesn't have to invent the verification path.

### What would invalidate this design

- Upstream API breaking change (e.g. `Engine.place_limit_order` signature drift between SHAs). Detected at next pin bump; redo the request mapping subsection.
- Polymarket killing public-API book reads. Sidecar becomes useless; falls back to live mode for all targets. Out-of-scope risk (Polymarket-level decision).
- Constraint change to allow SELL or market orders. The fidelity story breaks per the project's strict constraints; revisit the OSS-engine choice before continuing PR 3 work.
- A migration in `pm_trader.db` between pinned SHAs that's not idempotent. Mitigation: read CHANGELOG before each bump; if a migration is required, wipe the SQLite file at startup (ephemeral v0 makes this free).

<!-- candidate-a validation snapshot 2026-05-17 -->
