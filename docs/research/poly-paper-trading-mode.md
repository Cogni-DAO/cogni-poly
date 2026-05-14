---
id: research-poly-paper-trading-mode
type: research
title: "Polymarket Paper-Trading Mode for the Copy-Trade Mirror"
status: active
trust: draft
summary: "Polymarket has no public sandbox. The mirror algorithm must run end-to-end (decision, ledger, observability) with only the CLOB-place call swapped for a paper backend — shadow-attribution is rejected because it skips the algorithm. Our constraints (limit-orders-only, ride-to-redemption) eliminate the OSS-sim failure modes that previously capped fidelity around 92-95%: no SELL slippage, no neg-risk SELL routing, no market-order partial fills. The remaining problem is deterministic — does a passive BUY limit at price P cross the live ask book before resolution. agent-next/polymarket-paper-trader (MIT, Python MCP/CLI) already implements exactly this via live-book polling + wire-correct Polymarket fee formula. Recommend wiring it as a Python sidecar behind the existing PaperAdapter shape; the mirror's planMirrorFromFill, OrderLedger, decision audit, and 30s wallet-watch lag all stay intact. Honest remaining gap: queue position at congested price levels (~few percent of cases for small sizes in low-liquidity copy-trade markets). Redemption inherits live mode's on-chain ConditionResolution listener — no simulator touches it."
read_when: Scoping paper-trading mode for a limit-only ride-to-redemption copy-trade mirror; evaluating whether agent-next/polymarket-paper-trader meets the OSS-only fidelity bar; deciding where in the trade-executor the CLOB call should be swapped; understanding why shadow-attribution is the wrong tool when the goal is algorithm validation.
owner: derekg1729
created: 2026-05-14
verified: 2026-05-14
tags:
  [
    knowledge-chunk,
    polymarket,
    copy-trading,
    paper-trading,
    poly-node,
    architecture,
  ]
---

# Research: Polymarket Paper-Trading Mode for the Copy-Trade Mirror

> spike: (ad-hoc, no work item yet) | date: 2026-05-14

## Question

Can we run our Polymarket copy-trade mirror in a paper-trading mode that does not spend real USDC, **with the full mirror algorithm running end-to-end** — same `planMirrorFromFill` decisions, same `OrderLedger` writes, same decision audit, same observability — and **only** the final CLOB-place call swapped for a paper backend, so the data we gather actually reflects how the algorithm performs?

**Strict constraints:**

1. **No fill logic written by us.** The fill model must come from an existing OSS tool. Divergence from reality makes the data worthless.
2. **The algorithm must run.** Shadow-attribution (recording target's actual fill price scaled to our size) is rejected — it bypasses our algorithm and ignores everything that affects whether _we_ would have actually filled (poll lag, minimum order size, tick size, book mutation during the lag, queue position).
3. **Limit orders only.** The mirror only places limit orders.
4. **Ride to redemption.** Positions exit via on-chain `ConditionResolution`, not via SELL. No SELL leg exists.

These last two constraints dramatically narrow what a paper backend must simulate: only "does a passive BUY limit at price P, placed at time T, ever cross the live ask book before resolution?" — a deterministic question against live book history.

## Context

The copy-trade mirror is live-money today. Bugs in the mirror algorithm (delta vs target VWAP, sizing, cap enforcement, fill-detection lag) burn real USDC when they slip past CI. Before adding new targets or tuning aggressiveness we want a paper mode that exercises the **full algorithm** — decision, ledger insert, place, reconciliation — without touching the CTF Exchange.

**The strategy constraints simplify the fidelity problem materially:**

- The algorithm only emits BUY limit orders. No SELL, no market orders.
- Positions exit via redemption (on-chain `ConditionResolution`), not via SELL. The redemption path is already implemented for live mode and is deterministic from chain events — it reuses identically in paper mode (no simulator involved).
- The fill-fidelity question reduces to **"does our passive BUY limit at price P cross the live ask book within the time horizon"** — a question that is answered by replaying live book data, not by guessing matching-engine behavior.

These constraints retire the OSS-sim failure modes that previously capped fidelity at ~92-95%: SELL slippage, neg-risk SELL routing, market-order partial fills, aggressive-side queue jumping. The remaining gaps are smaller and clearly bounded.

Existing assets (already in repo):

- **Paper adapter shape (frozen)**: `nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts` — `PaperAdapter implements MarketProviderPort`, all methods throw `NotImplementedError`. Body explicitly deferred to Phase 3 of `task.0315`.
- **Per-target `mode` field**: `MirrorTargetConfig.mode: "live" | "paper"` typed at `nodes/poly/app/src/features/copy-trade/types.ts:172` and in the v1 contract at `nodes/poly/packages/node-contracts/src/poly.copy-trade.targets.v1.contract.ts:54`.
- **Decision-layer routing**: `planMirrorFromFill()` already emits `reason: "mode_paper"` for paper-mode fills (`plan-mirror.ts:534`); the decision is `kind: "place"` so the executor still needs a real backend.
- **Bootstrap stub**: `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts:243` hardcodes `mode: "live"` with the comment `paper adapter body lands in P3; v0 only places live`.
- **Placement chokepoint**: `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts:349-353` — exactly one call site binds `adapter.placeOrder` into the `ClobExecutor`. This is the single seam where a paper backend gets swapped in.
- **DB ledger writes are decoupled from CLOB writes**: `insertPending()` fires before `executor()` regardless of backend, so paper trades show up in `poly_copy_trade_fills` and `poly_copy_trade_decisions` exactly like live trades. Observability is free.

In short: paper mode was designed-in from P1 and is partially wired. What's missing is (a) the adapter body, (b) the toggle mechanism, and (c) a decision on whether paper rows live next to live rows.

## Findings

### Polymarket has no usable sandbox

Verified against primary sources:

- `docs.polymarket.com` makes zero references to sandbox, testnet, staging, or paper-trading.
- The official `clob-client-v2` README has no sandbox host string — only `<polymarket-clob-host>` as a placeholder.
- `data-api.polymarket.com` and `user-pnl-api.polymarket.com` are production-only; no documented split.
- The CTF Exchange v2 contracts **are** deployed on Polygon Amoy (`CTFExchangeV2: 0xE111…996B`, `NegRiskCtfExchangeV2: 0xe222…0F59`) but have no matcher, no oracle resolution feed, no makers, no liquidity. Contract-test infrastructure, not a tradable testnet.
- One real non-prod endpoint exists — `relayer-v2-staging.polymarket.dev` — but it is the gasless V2 relayer (tx submission), not the order-matching CLOB.

**Architectural reason this won't change:** Polymarket matches off-chain and settles on-chain via CTF Exchange. A test order still needs an EIP-712 signature over a chain ID and a matcher willing to engage. The matcher and maker liquidity only exist on mainnet. Even an inert sandbox endpoint can't produce realistic fills.

### OSS fill-simulator survey

We evaluated every OSS Polymarket paper-trading project we could find against three axes: **fidelity** (does it actually model real fills), **integration shape** (how it plugs into a TS Node service), and **license + maintenance**.

#### `agent-next/polymarket-paper-trader` — MIT, MCP sidecar — **Fidelity: B+ taker / C limit**

- 328 stars, last push 2026-03-02. Python. MCP stdio server + CLI (`pm-trader buy/sell/place_limit_order/check_orders`).
- `orderbook.py` walks the real live Polymarket REST/WS book level-by-level. Fee formula is wire-correct: `bps/10000 × min(price, 1-price) × shares`. Engine docstring claims _"1:1 faithful to Polymarket execution."_
- **Gaps that prevent 99%:** no queue-position model, no latency injection, no neg-risk bundle semantics, limit fills checked by polling rather than a matching engine. Walks the whole book in one shot (unrealistic vs partial fills).
- Repo: <https://github.com/agent-next/polymarket-paper-trader>

#### `braedonsaunders/homerun` — **AGPL-3.0**, FastAPI monolith — **Fidelity: A (claimed)**

- 58 stars, last push 2026-05-14. The _only_ OSS project that names microstructure-aware fill simulation as a first-class feature.
- Claims: persisted `MarketMicrostructureSnapshot` (25 levels each side, 0.5s sampling); trade-vs-cancel decomposition off the trade tape; **Cox proportional hazards `P(fill within Δt)` model**; measured-latency injection from rolling p50/p95/p99 distributions; pessimistic/realistic/optimistic ensemble per order; shadow↔live toggle sharing identical API.
- **Killer blocker:** AGPL-3.0 forces any service that links it to open-source itself. Non-starter for our hosted node service. Also single-author and unverified at scale.
- Repo: <https://github.com/braedonsaunders/homerun>

#### NautilusTrader + `evan-kolberg/prediction-market-backtesting` — LGPL — **Fidelity: A− backtest, C live**

- Nautilus: 22.7k stars, LGPL-3.0, Rust+Python. Kolberg adapter: 854 stars, MIT.
- Best book-replay fidelity in OSS (L2 deltas + trade ticks). v4.1-alpha just added a "live sandbox plumbing for Polymarket BTC 5min markets" — i.e. forward-paper exists but is partial: BTC-5m only, "strategy & model not included." Kolberg README itself contains a section titled _"Why Exact Reproduction Fails"_.
- **Wrong tool for our need.** Designed for historical backtests; the live-paper path is alpha and narrow.
- Repos: <https://github.com/nautechsystems/nautilus_trader>, <https://github.com/evan-kolberg/prediction-market-backtesting>

#### Others, rejected

- `clawdvandamme/polymarket-trading-bot` — 0 stars, no license, abandoned.
- `ent0n29/polybot` — 622 stars, MIT, Java — strategy infra, not a fill simulator.
- `direkturcrypto/polymarket-terminal` — 248 stars, no license — live mirror, no sim layer.
- **No OSS exists** for: shadow-fill simulators (target wallet → simulated PnL stream), local CLOB matching emulators fed by prod WS, polymarket-shadow / wallet-mirror sim projects.

### The honest 99% conversation

No OSS fill simulator clears 99% fidelity for Polymarket today. Concrete gaps in every candidate:

1. **Queue position / maker fills** — none model "you were N-th in line at this tick." Limit orders fill the moment best price crosses → too optimistic.
2. **Latency** — real CLOB place + WS confirm is ~150-400ms. Adverse selection happens in that window.
3. **Partial fills + adversarial pulls** — none simulate counterparties pulling depth after we route.
4. **Neg-risk markets** — no OSS handles the bundle/split semantics correctly. SELL on neg-risk routes differently in prod.
5. **Mid-trade book mutation** — snapshot-fill simulators ignore book changes between sim and submit.

Realistic ceiling for the best OSS sim (`agent-next/polymarket-paper-trader`) is **~92-95%** on taker-only, non-neg-risk fills sized small enough to clear top-of-book. Not the 99% bar.

### Where 99% IS achievable: fill-shadowing the target

There is a way to clear 99% fidelity for the copy-trade use case specifically — but it works **only because we are copy-trading**, not paper-trading in the general sense.

**Fill-shadowing**: when the target wallet fills (we observe this via `wallet-watch` + Data-API), we record a shadow fill at the **target's actual reported fill price**, scaled to our intended size. We never call any simulator. The price is real because reality executed the order on real money against the real book at that microsecond. Our "fidelity" is the target's fidelity, which is 100% by construction.

This is not a simulator — it is data attribution. **No "fill model" code gets written**, satisfying the user's constraint. The pieces required (wallet-watch, fill price from Data-API, target-→-mirror size scaling) are entirely data flow, not modeling.

Trade-off explicitly accepted: **shadow mode validates the target, not the algorithm.** It cannot catch bugs in our own mirror code (delta vs VWAP, neg-risk handling, hedge follow-ups, cap enforcement) because the algorithm is not exercised — we just record target's fills scaled. To catch algorithm bugs, the only honest paths are: (a) staging with tiny real money sizes (perfect fidelity, real cost), or (b) accept the OSS sim's ceiling (~92-95%) for algorithm validation specifically.

### Re-evaluating `agent-next/polymarket-paper-trader` under the real constraints

My earlier ~92-95% fidelity grade was given against a general taker/maker mixed workload. Under **limit-only + ride-to-redemption**, the picture changes:

| Failure mode I previously cited                                     | Applies under our constraints?                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No queue-position model — limit fills the moment best price crosses | **Yes**, still a gap. In low-liquidity copy-trade markets with small sizes, you're often alone at your price level — gap is small. In congested levels, optimistic.                                                                                    |
| No latency injection — assumes instant place                        | **No.** Our `MIRROR_POLL_MS=30000` already injects 0-30s of real lag _before_ the place call. Paper inherits this.                                                                                                                                     |
| Partial fills not modeled — walks the whole book in one shot        | **Mostly N/A.** That gap is about taker market orders eating multiple book levels. Passive limits at a single price either fill or don't — partial fills only happen when book depth at our price is less than our size, which the tool _does_ handle. |
| Neg-risk bundle/split semantics                                     | **N/A.** Neg-risk semantics matter on SELL, not BUY-and-redeem.                                                                                                                                                                                        |
| Mid-trade book mutation                                             | **Mostly N/A** for limit orders. The limit sits at our price. If the book moves away, our limit just doesn't fill — that's the correct outcome, not a fidelity gap.                                                                                    |
| Adversarial counterparty pulls                                      | **N/A** for passive limits. We're not chasing depth, we are sitting on the book.                                                                                                                                                                       |
| Polymarket fee formula correctness                                  | **Already correct.** Wire-correct `bps/10000 × min(price, 1-price) × shares`.                                                                                                                                                                          |
| Minimum order size / tick size enforcement                          | **Already correct.** The tool calls Polymarket constraints just like our live adapter. (If it didn't, our mirror's existing order-validation layer would catch it pre-place anyway.)                                                                   |

The realistic fidelity under our constraints rises to roughly **96-98%**. The dominant remaining gap is queue position at congested price levels — and for v0 cap sizes ($1-50/trade) in the low-liquidity markets our copy-trade targets tend to enter, this gap is small.

This isn't literally 99%, but it is **the highest-fidelity option that exists in OSS today**, and writing our own fix would mean writing a queue-position model — which is exactly the kind of fill-logic divergence the constraint forbids.

### Other OSS candidates re-checked under the new constraints

- **`braedonsaunders/homerun`** — Cox-hazards fill model would close the queue-position gap. AGPL-3.0 still rules it out for a hosted service. Unchanged verdict.
- **NautilusTrader + Kolberg adapter** — has a real matching engine but live-paper path is BTC-5m-alpha only. Backtest mode could re-validate historical strategies, but it's not a forward paper-trading runtime. Wrong tool.
- **`direkturcrypto/polymarket-terminal`**, **`ent0n29/polybot`**, **`clawdvandamme/polymarket-trading-bot`** — unchanged verdicts (no sim, wrong tool, abandoned).

`agent-next/polymarket-paper-trader` remains the only viable OSS engine. The constraints don't change _which_ tool to use — they change _how high_ its fidelity ceiling is.

### Why shadow-attribution is now rejected

I had recommended shadow-attribution as a 99% complement. The user correctly rejected this: it skips our algorithm entirely. Shadow rows look great because they inherit target's real fill, but they answer the wrong question. The mirror algorithm has its own failure modes that only surface when the algorithm runs end-to-end:

- The 30s `MIRROR_POLL_MS` lag means our placement happens after target's fill. The book may have moved. Shadow ignores this.
- Polymarket has per-market minimum order size in USDC. If target fills $200 and our scaled mirror is $1.50, that may fall below the minimum and skip entirely. Shadow ignores this.
- Tick size: target's price was 0.4237, but Polymarket ticks at 0.01 — our limit gets rounded to 0.42 or 0.43. Shadow ignores this.
- `planMirrorFromFill` has its own decision lattice (sizing scale-in, cap enforcement, layer-scale-in heuristics). Shadow ignores all of it.

Shadow is the wrong tool. Rejected.

## Recommendation

**One mode: `mode: "paper"`. Backed by `agent-next/polymarket-paper-trader` MIT sidecar. Algorithm runs end-to-end; only the CLOB-place is swapped.**

Justification:

1. **Algorithm runs end-to-end.** `planMirrorFromFill` makes the same decisions. `OrderLedger.insertPending` writes the same rows. Decision audit, Pino/Loki, metrics — all unchanged. The `MIRROR_POLL_MS` lag, minimum-order-size, tick-size, cap-enforcement code paths all exercise exactly as in live mode.
2. **The swap point is small.** One seam: `poly-trade-executor.ts:349-353`. When `intent.mode === "paper"`, route the limit-place through the sidecar instead of `adapter.placeOrder`.
3. **Fill model is upstream OSS, not ours.** `agent-next/polymarket-paper-trader` watches the live book and reports when our limit crossed. Fees are wire-correct. We write only the adapter — no fill logic, no queue-position guesswork, no "logic that can diverge from reality."
4. **Redemption is free.** Ride-to-redemption means position exits via `ConditionResolution` on-chain, which live mode already listens for. Paper rows get the same redemption stamp from the same listener. No simulator involved on the exit side.
5. **No fork or vendor of upstream.** Sidecar process boundary keeps `agent-next` upstream-pristine. If they update the fee formula or fix a bug, `git pull` in the sidecar build.

Trade-offs explicitly accepted:

- **Python sidecar in our TS Node stack.** Run `pm-trader-mcp` in a sibling container in the same k3s pod. Observability via stdout → Loki, same as our other workloads. Modest deploy work.
- **~96-98% fidelity ceiling, not 99%.** Queue position at congested price levels is the irreducible gap. Acceptable because the alternative (writing our own queue model) is precisely what the constraint forbids.
- **Maintenance signal on `agent-next` is light.** Last commit March 2026. We accept the risk that fee/tick rules drift and the upstream lags. Mitigation: pin a known-good commit hash; subscribe to the upstream repo for notifications.
- **`braedonsaunders/homerun` would be technically better** but AGPL-3.0 is non-negotiable. Documented and moved on.

### Deploy topology: three environments already exist

The Cogni infra already has three Kustomize overlays for the poly node — `infra/k8s/overlays/{candidate-a,preview,production}/poly/kustomization.yaml`. Each is a fully independent deployment with its own namespace, VM, DB, ingress, and ConfigMap. We use this **as-is** — paper trading does not need a fourth environment, it needs `PAPER_ENFORCE_MODE` to be set in the ConfigMaps for two of the three.

| Environment     | URL                         | Lifetime                | Paper mode                                                     | Purpose                                                                                                                                           |
| --------------- | --------------------------- | ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **candidate-a** | `poly-test.cognidao.org`    | Ephemeral (per-PR slot) | `PAPER_ENFORCE_MODE=paper` (forced)                            | PR validation — `/validate-candidate` against paper. **Bugs in any flighted PR cannot burn real money, ever.**                                    |
| **preview**     | `poly-preview.cognidao.org` | Continuous              | `PAPER_ENFORCE_MODE=paper` (forced)                            | The **AI-owned always-paper twin.** Runs the production algorithm 24/7 against live books with simulated fills. Long-horizon strategy evaluation. |
| **production**  | `poly.cognidao.org`         | Continuous              | No override; per-target `mode` field controls (default `live`) | Real money. Per-target paper mode still usable for trying a new wallet safely.                                                                    |

The change to land paper-enforcement on candidate-a and preview is **3 lines per overlay** — add `PAPER_ENFORCE_MODE: "paper"` to the ConfigMap patch in `infra/k8s/overlays/candidate-a/poly/kustomization.yaml` and `infra/k8s/overlays/preview/poly/kustomization.yaml`. No new VM, no new Argo app, no new DNS, no new image.

### Why this maps the AI-iteration loop cleanly

The user's vision — _"AI owning the trading config, consistent iteration + update to the algorithm, real-time paper testing"_ — falls out of the existing CD pipeline once paper mode exists:

1. **AI agent works on a feature branch.** Writes algorithm tweak (e.g. sizing heuristic). Opens PR.
2. **CI green → `vcs/flight` → candidate-a.** PR auto-flights to `poly-test.cognidao.org`. `PAPER_ENFORCE_MODE=paper` is set there; the new algorithm code cannot burn real money even if buggy.
3. **`/validate-candidate` runs.** Algorithm exercises end-to-end against paper. Scorecard posted. Merge gated on `deploy_verified: true`.
4. **Merge → preview auto-deploys.** Long-horizon paper evaluation begins. Days-weeks of continuous paper fills accumulate in `poly-preview`'s DB. Grafana shows paper PnL trend.
5. **Promote to production manually** (Derek-gated) after the AI's algorithm has demonstrated a paper-PnL signal that beats baseline over N days.
6. **In production**, the same algorithm runs against `mode: "live"` targets. New targets can still enter as `mode: "paper"` in production to validate before promoting to live spend.

Two different test horizons in one pipeline:

- **candidate-a paper** validates _"the algorithm code path is correct"_ (seconds-minutes).
- **preview paper** validates _"the algorithm strategy is profitable"_ (days-weeks).

### Why a separate repo is the wrong cut

User raised: could trading config / algorithm live in a separate repo with its own AI owner? **Recommend no.**

- Type sharing (Zod contracts in `@cogni/poly-node-contracts`) is monorepo-native and load-bearing.
- The algorithm imports from `MarketProviderPort`, `OrderLedger`, `OrderIntent`, `OrderReceipt` — all `nodes/poly` internals. A separate repo forces these to be versioned packages with semver discipline; that's a large tax for unclear gain.
- CI/CD already aligns: the per-PR flight + candidate-a + preview + production loop is built into this monorepo. Splitting forces re-implementation.
- **CODEOWNERS gets you the ownership boundary without the split.** Scope `nodes/poly/app/src/features/copy-trade/**` to the AI agent's identity. PRs touching that subtree route to the agent for review; PRs touching other subtrees don't. Cross-cutting changes (e.g. extending `MarketProviderPort`) still land as single PRs.

Reconsider only if the AI agent's iteration cadence becomes incompatible with the rest of the monorepo's CI cycle (50+ PRs/day, contention on the candidate-a slot). At that point the right answer is per-app slot isolation (already partially designed in `task.0370`-class work), not a repo split.

## Open Questions

1. **Sidecar deploy shape.** `agent-next/polymarket-paper-trader` is Python; our node services are TS. Options: (a) sibling container in the same k3s pod, communicating over loopback HTTP or MCP stdio; (b) co-located k3s deployment in the same namespace, talked to via Service DNS; (c) wrap it as a Python subprocess of the Node app. Recommend (a) — pod-scoped lifecycle, simple env wiring, no extra Service object.
2. **Sidecar API surface.** `pm-trader` exposes a CLI and an MCP stdio server, but no native HTTP server. Spike: either expose its functions over a thin FastAPI wrapper (small, but is that "writing logic"? It's transport, not fill logic — likely acceptable) or shell to the CLI per call (simpler but per-call subprocess overhead). MCP stdio inside a long-lived sidecar would avoid both.
3. **State ownership for open paper orders.** The sidecar holds a list of "currently open limit orders" in its own process state. If the pod restarts, those are lost. Options: (a) persist open paper orders in `poly_copy_trade_fills` with `status: "open"` and on boot, replay them into the sidecar; (b) accept that paper orders die on restart (acceptable in early days). Prefer (a) for parity with live, but (b) is fine for v0.
4. **Pinning upstream.** `agent-next/polymarket-paper-trader` is light-maintenance. Pin a known-good commit SHA in our sidecar Dockerfile. Decide review cadence (weekly? quarterly?).
5. **Reconciliation.** When sidecar reports "filled," `OrderReconciler` needs to learn about it. Options: (a) sidecar pushes a fill event we consume (preferred — same shape as a real CLOB fill webhook); (b) we poll the sidecar like we poll the CLOB today. Reuse whichever fits the existing reconciler shape with less code.
6. **Position aggregation for paper.** `closePosition()` / `exitPosition()` currently call `data-api.polymarket.com/positions`. Paper positions must aggregate from `poly_copy_trade_fills WHERE mode = 'paper'`. The redemption stamp comes from the same on-chain `ConditionResolution` listener as live — no special path needed for the exit; only the "what positions do we have" read needs branching.
7. **Tick/min-size discovery.** The mirror algorithm already calls `getMarketConstraints()` before placing. In paper mode this still calls the live market-provider for constraints (we want real tick + min size). Confirm the live call stays in paper mode and only the placement is swapped.
8. **Fee correctness drift.** Polymarket can change fee rates without warning. Pin a CI smoke test that re-computes a known fixture against `pm-trader`'s formula and fails if upstream drifts. Cheap insurance.
9. **Maker-side queue position gap.** The known fidelity gap. Decide policy: do we apply a confidence haircut on paper-PnL dashboards, or just document it? Recommend: document in the panel, no haircut. Algorithm-validation is binary (does the code path execute correctly), not probabilistic.

## Proposed Layout

### Project

`proj.poly-paper-trading` — three phases, each shippable independently. Each phase delivers user-visible value; the AI-iteration loop unlocks at the end of Phase 2.

**Phase 1 — Paper engine (sidecar + adapter body).** Make `mode: "paper"` work in a single environment, for a single target, end-to-end. Definition of done: one target flipped to `mode: "paper"` in production produces decision + fill + redemption rows tagged `mode = 'paper'`.

**Phase 2 — Always-paper deployments (candidate-a + preview).** Enable `PAPER_ENFORCE_MODE=paper` in the two non-prod overlays. Definition of done: every flighted PR auto-validates against paper; preview runs continuous 24/7 paper algorithm.

**Phase 3 — AI-iteration polish.** CODEOWNERS, per-environment Grafana, runbook, automated promote-from-preview signals. Definition of done: an AI agent owns `nodes/poly/app/src/features/copy-trade/**` and the promote loop is documented end-to-end.

### Specs

- **Update copy-trade spec** to document `mode: "paper"` semantics, `PAPER_ENFORCE_MODE` env var, the three-environment topology, and the `agent-next` dependency.
- **Update trade-executor spec** for dispatch-on-`intent.mode` branching.
- No new spec file.

### Phase 1 — Paper engine (the pareto-essential foundation)

These four tasks unblock everything else. Ship in order.

1. **`spike.A` — Sidecar integration shape** _(doc-only, ≤1 day)_
   Resolve open questions 1-3, 5. Output: pod layout (sibling container in same k3s pod), transport choice (MCP stdio vs FastAPI loopback), pinned upstream commit, state-recovery policy for open paper orders, reconciler integration shape. Drives `task.B` and `task.C`.

2. **`task.B` — Paper sidecar image**
   Dockerfile pulls pinned `agent-next/polymarket-paper-trader`, runs the chosen entrypoint. Smoke test: place a limit, observe fill detection against a recorded book fixture. Publish to `ghcr.io/cogni-dao/poly-paper-sidecar`.

3. **`task.C` — `PaperAdapter` body as sidecar client** _(critical seam)_
   Fill in `nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts:73-87`. `placeOrder()` / `getOrder()` / `cancelOrder()` become typed IPC calls to the sidecar. Zod-parsed responses, no fill logic written. Sibling container added to the k3s Deployment via base manifest. Unit tests against a fake sidecar.

4. **`task.D` — Executor dispatches on `intent.mode`** _(critical seam)_
   `poly-trade-executor.ts:281-407` builds both `livePlace` and `paperPlace` once at boot; `authorizedPlace` selects on `intent.mode`. Extend `OrderIntent` with `mode`. Add `PAPER_ENFORCE_MODE` env var read at bootstrap that overrides per-target mode to `"paper"` when set.

After Phase 1, you can flip a single target to paper and the algorithm runs end-to-end. The other tasks below make this usable at scale.

### Phase 1 continued — Schema + bootstrap (must accompany Phase 1)

5. **`task.E` — Schema: `mode` column on `poly_copy_trade_fills` + `poly_copy_trade_decisions`**
   `mode: "live" | "paper" NOT NULL DEFAULT 'live'`. Update SELECT call sites, RLS policies. Follow `/schema-update`.

6. **`task.F` — Bootstrap reads DB `mode`**
   Remove the hardcoded `mode: "live"` at `copy-trade-mirror.job.ts:243`. Read from `poly_copy_trade_targets`. Adjust `plan-mirror.ts:534` so paper-mode fills produce `kind: "place"` (routing to the paper adapter), not skip.

7. **`task.G` — Position aggregation paper-awareness**
   `closePosition()` / `exitPosition()` branch to read positions from `poly_copy_trade_fills WHERE mode = 'paper'` for paper targets, rather than Data-API. Open question 6.

8. **`task.H` — Verify redemption listener stamps paper rows**
   Test-only task confirming the existing `ConditionResolution` listener already writes redemption rows for paper positions. Likely no new logic needed; if it does, scope is small.

### Phase 2 — Always-paper deployments (the AI-iteration unlock)

The compact 3-line-per-file change that turns Phase 1 into a continuous AI-iteration loop.

9. **`task.I` — `PAPER_ENFORCE_MODE=paper` on candidate-a overlay**
   Add to the ConfigMap patch in `infra/k8s/overlays/candidate-a/poly/kustomization.yaml`. Verify on next candidate-a flight that the deployed pod boots with `PAPER_ENFORCE_MODE=paper` and refuses to issue live CLOB orders.

10. **`task.J` — `PAPER_ENFORCE_MODE=paper` on preview overlay**
    Same change for `infra/k8s/overlays/preview/poly/kustomization.yaml`. Verify preview's continuous mirror loop produces paper fills against live target activity for 24h.

11. **`task.K` — Production CLOB-credential safety check**
    Bootstrap-time assertion: if `PAPER_ENFORCE_MODE=paper`, refuse to load live CLOB credentials at all. Belt-and-suspenders defense against an env-var typo accidentally routing live orders through paper code paths.

### Phase 3 — AI-iteration polish

12. **`task.L` — CODEOWNERS for copy-trade subtree**
    Scope `nodes/poly/app/src/features/copy-trade/**` and `nodes/poly/app/src/features/trading/**` to the AI agent's identity. Cross-cutting changes (e.g. `MarketProviderPort` extensions) remain repo-wide review.

13. **`task.M` — Per-environment Grafana panels**
    `mode` filter on copy-trade dashboards. Three side-by-side panels: candidate-a paper / preview paper / production live PnL. Sim-fidelity caveat on the paper panels. Follow `/data-research` — SQL aggregation.

14. **`task.N` — CI fee-drift smoke test**
    Open question 8. Pinned-fixture test re-checks `pm-trader`'s fee output against a known-correct vector. Fails on upstream drift.

15. **`task.O` — Docs + runbook**
    Update copy-trade + trade-executor specs. One-page runbook covering: enabling paper mode per-target, the AI-iteration loop end-to-end (PR → candidate-a paper → preview paper → prod), verifying sidecar health, when to promote, when to roll back.

### Deferred

- **Separate `poly-paper.cognidao.org` deployment.** Out of scope unless preview's namespace becomes contended. The three-environment topology already provides the always-paper twin (`preview`).
- **Separate repo for copy-trade code.** Rejected — see "Why a separate repo is the wrong cut" above. CODEOWNERS gets the ownership boundary.
- **Queue-position fidelity model** (the irreducible OSS gap). Either accept the 96-98% ceiling or revisit if a non-AGPL queue model appears.

### Pareto shortcut

If you want the **minimum viable AI-iteration loop**, Phases 1 + 2 (tasks A through K, 11 items) ship the full workflow. Phase 3 is polish — usable without it. Phase 1 alone (without Phase 2) is useful for a one-off paper experiment but doesn't deliver the always-paper twin.

## References

### Code seams in our repo

- `nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts` — frozen P1 stub
- `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts:281-407` — placement chokepoint
- `nodes/poly/app/src/features/copy-trade/plan-mirror.ts:534` — `mode_paper` decision routing
- `nodes/poly/app/src/features/copy-trade/types.ts:172` — `mode` enum
- `nodes/poly/packages/node-contracts/src/poly.copy-trade.targets.v1.contract.ts:53` — v1 contract `mode` field
- `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts:243` — hardcoded `mode: "live"` to remove

### Polymarket (no sandbox)

- [docs.polymarket.com](https://docs.polymarket.com/) — no sandbox/testnet section
- [Polymarket/clob-client-v2](https://github.com/Polymarket/clob-client-v2) — no sandbox host
- [Polymarket/ctf-exchange-v2](https://github.com/Polymarket/ctf-exchange-v2) — Amoy contracts (inert)

### OSS fill simulators evaluated

- [agent-next/polymarket-paper-trader](https://github.com/agent-next/polymarket-paper-trader) — MIT, 328★, Python MCP sidecar — **recommended for sim mode**
- [braedonsaunders/homerun](https://github.com/braedonsaunders/homerun) — AGPL-3.0 (rejected), 58★, best fidelity model
- [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) + [evan-kolberg/prediction-market-backtesting](https://github.com/evan-kolberg/prediction-market-backtesting) — backtest-grade, live-paper alpha-only
- [ent0n29/polybot](https://github.com/ent0n29/polybot), [direkturcrypto/polymarket-terminal](https://github.com/direkturcrypto/polymarket-terminal), [clawdvandamme/polymarket-trading-bot](https://github.com/clawdvandamme/polymarket-trading-bot) — all rejected (see Findings)
