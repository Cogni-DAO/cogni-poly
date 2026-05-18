---
id: proj.poly-paper-trading.handoff
type: handoff
work_item_id: proj.poly-paper-trading
status: active
created: 2026-05-16
updated: 2026-05-16
branch: derekg1729/paper-trading-pr3-impl
pr: 56
last_commit: 5e20292fc
---

# Handoff — Paper Trading is LIVE on candidate-a. Next: AI-Controlled Algorithm Experimentation

Previous handoff (PR1-era pointer for review) archived to [`archive/proj.poly-paper-trading/2026-05-14T18-00-00.md`](archive/proj.poly-paper-trading/2026-05-14T18-00-00.md).

## TL;DR

End-to-end paper trading fires today on candidate-a. A real user added a copy-trade target; the mirror loop picked it up; orders flowed through `mirror-pipeline → poly-trade-executor (paper) → PaperAdapter → poly-paper-sidecar → pm_trader.Engine` against the live Polymarket book. PR #56 ships the v0 sidecar + the two TS-side gates that were silently blocking the entire flow (wallet-onboarding requirement + executor wallet-resolution).

Five paper orders placed in the first ~7 minutes of live testing. Validated via Loki cross-service join on `client_order_id`. Cogni Postgres records are present but mis-labeled `mode='live'` (bug #1 below).

## Where to look first

| Want to                                   | Read                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---- | -------------------------------- | ---------------- |
| Architectural overview + invariants       | `work/projects/proj.poly-paper-trading.md` (~700 lines, PR1+PR2+PR3 design + review-design all there) |
| OSS engine choice + fidelity ceiling      | `docs/research/poly-paper-trading-mode.md`                                                            |
| Sidecar runtime contract + bump checklist | `infra/images/poly-paper-sidecar/AGENTS.md`                                                           |
| What ran today on candidate-a             | Loki: `{namespace="cogni-candidate-a"}                                                                | json | event=~"adapter.paper_sidecar.\* | poly.mirror.\*"` |

## What PR #56 actually shipped

Branch: `derekg1729/paper-trading-pr3-impl` (PR #56). Reviewable in order:

1. **Sidecar v0** — `infra/images/poly-paper-sidecar/`
   - Pinned `agent-next/polymarket-paper-trader v0.1.6` (commit `8a0a3ee2`) via `pip install git+https`
   - `server.py` — FastAPI app, `threading.Lock` + sync handlers (FastAPI runs them in its threadpool), daemon fill-poll thread every 30s
   - Multi-stage Dockerfile with `target=test` as a CI build-blocker (pytest under stubbed `pm_trader.engine`, 12 cases ~0.4s)
   - SQLite `check_same_thread=False` monkey-patch — only safe because the global lock serialises every Engine call (caught on candidate-a — local pytest missed it because tests ran single-threaded)
   - In-memory `OrderState` map carries `client_order_id` across requests (upstream Engine doesn't track it)
   - `market_id` prefix strip: cogni's `prediction-market:polymarket:<conditionId>` → bare conditionId for `Engine.place_limit_order`
   - Observability: real JSON formatter, `nodeId=poly` + `service=poly-paper-sidecar` base bindings, `adapter.paper_sidecar.*` event registry, `errorCode` enum, `fill_loop.tick_complete` heartbeat for Loki absence alerts

2. **Overlay digest pinning** — `infra/k8s/overlays/{candidate-a,preview}/poly/`
   - Both `cogni-poly` and `poly-paper-sidecar` pinned via `digest:` (not `newTag:`) — sidesteps `promote-k8s-image.sh`'s sed bug
   - Stripped the word "digest" from comments inside the `images:` block (the same sed eats comment matches — bug #2 below)

3. **Wallet-gate bypass in `listAllActive`** — `nodes/poly/app/src/features/copy-trade/target-source.ts`
   - `dbTargetSource({ paperEnforced })` — when true, skip the `polyWalletConnections` + `polyWalletGrants` INNER JOINs that would otherwise require Privy wallet onboarding
   - Bootstrap wires `paperEnforced: env.PAPER_ENFORCE_MODE === "paper"`
   - Without this fix targets never activate on candidate-a; `active_targets:0` forever

4. **Paper-only executor builder** — `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts`
   - `buildPaperOnlyExecutor` branch chosen when `paperEnforceMode === "paper"`
   - Skips `walletPort.resolve()` (no tenant wallet needed for paper)
   - Skips `walletPort.authorizeIntent()` (no real USDC to authorize)
   - Constructs `PolymarketClobAdapter` with deterministic no-op signer + empty CLOB creds — the SDK's public read endpoints (`getOrderBook`, `getTickSize`) used by `getMarketConstraints` don't auth
   - `closePosition` / `exitPosition` / `listOpenOrders` / `getPositionShareBalance` throw `paper_enforced_not_supported`; mirror BUY path doesn't call them
   - Closes the explicit `TODO(follow-up)` that was sitting on `PolyTradeExecutorFactoryDeps.paperEnforceMode` since PR #38

5. **Design + design-review** — appended to `work/projects/proj.poly-paper-trading.md`
   - PR3 roadmap; design with verified upstream surface (`Engine.place_limit_order(slug_or_id, outcome, side, amount, limit_price, order_type="gtc")` returns `dict`); threading + lock model; market-id translation; v0 full-fill convention; logging strategy

## What's NOT working / known bugs

### 1. DB `mode` mis-attribution — every paper fill is labeled `mode='live'` in cogni Postgres ✅ RESOLVED (task.5003, PR #98)

**Symptom (historical):**

```sql
SELECT mode, status, order_id FROM poly_copy_trade_fills WHERE created_at > now() - interval '15 min';
-- 5 rows, all mode='live', order_id=1..5 matching sidecar
```

Decisions same story.

**Root cause (corrected):** the Drizzle order-ledger never wrote `mode` to `poly_copy_trade_{fills,decisions}` at all — the DB default `'live'` fired on every row regardless of the `target.mode` value computed at `mirror-pipeline.ts`. The proposed `effectiveMode = paperEnforceMode === "paper" || target.mode === "paper" ? "paper" : "live"` fix below was right in spirit but landed differently:

**Fix as landed (task.5003 / PR #98):**

1. Establishes `MODE_STAMPED_AT_LEDGER_FROM_ENV` invariant — the order-ledger is the single write authority for the column. Bootstrap passes `serverEnv().PAPER_ENFORCE_MODE` to `createOrderLedger`, which resolves `effectiveMode` once at construction and stamps every `insertPending` + `recordDecision` insert with it.
2. Migration `0053` drops `poly_copy_trade_targets.mode` (never load-bearing, only misleading).
3. Drops the dead echoes: `MirrorTargetConfig.mode`, `intent.attributes.mode`, the `mode_paper` `MirrorReason` variant. Pairs with `PAPER_DISPATCH_IS_ENV_ONLY`.
4. **No retroactive backfill.** Initial draft would have flipped pre-cutover rows where `decisions.intent->>'mode' = 'paper'`, but on PROD that signal is unreliable: anyone who PATCHed a target's `mode` column to `'paper'` in the pre-`PAPER_DISPATCH_IS_ENV_ONLY` era left `intent.mode='paper'` in the JSONB while the executor still routed live. Flipping `fills.mode` based on that would mislabel real-money trades as paper. The analytics gap (pre-cutover paper rows stay labeled `'live'` on cand-a/preview) is accepted; new activity rebuilds analytics correctly.

### 2. `promote-k8s-image.sh` sed eats comments containing "digest"

The script does `sed s|digest: .*|...|` over a range, replacing **any** line in that range whose substring matches — including comments. Workaround in PR #56: strip "digest" from comments in the `images:` block. Real fix: image-name-aware sed (or replace promote-k8s-image.sh entirely; sibling agent is working on catalog v2 nested-images refactor that will).

### 3. `walletPort.authorizeIntent` is bypassed in paper-only mode

Logged as `authorize_bypassed: true`. **Intentional** — paper-only deployments have no wallet, no real USDC, no scope to enforce. In **production** (`PAPER_ENFORCE_MODE` unset), per-target `mode='paper'` rows still flow through the live builder, where authorize fires normally. The bypass only applies when the entire deployment is paper-enforced.

### 4. Sidecar SQLite is ephemeral (`/tmp/pm_trader/cogni-paper/`)

Pod restart wipes open paper orders. The cogni reconciler closes orphan pending rows the same way it handles a CLOB outage. Add a PVC if/when preview's redeploy cadence produces visible fill-rate loss. Not blocking.

### 5. `market_past_end_date` skips dominate for short-horizon targets

Derek's first test target (`0x204f72…`) trades on same-day-resolution markets (Polymarket "buy resolved losers at $0.0005 for oracle-flip optionality" arbitrage). 4 of 5 of its top positions resolve today. `isFillPastMarketEndDate` correctly skips → no placement.

**Not a code bug.** Pick targets that trade longer-horizon markets (elections, multi-week sports, political ongoings).

### 6. ~80% of placed paper orders show `status=cancelled` in cogni DB

5 paper orders placed; 4 show `cancelled`. Sidecar logs show they were placed successfully. Cause unclear — could be reconciler grace-window aging them out, could be a real bug. **Real investigation needed before claiming the algorithm works.**

### 7. `swisstony` wallet address is unresolved

User explicitly named `swisstony` as the canonical target for the AI-iteration phase. Need to identify the wallet — Polymarket leaderboard, Discord, etc.

## What's NEXT (the user's actual ask)

> "Next: we need to get set up with AI being able to control accounts, and experiment trading algorithms for copy-trading swisstony, and minimizing delta."

Suggested decomposition:

### Phase A — Lock the foundation (1-2 PRs)

- [ ] **Fix DB `mode` mis-attribution (bug #1).** Highest priority. Half-hour change in `copy-trade-mirror.job.ts`. Without it, no paper-mode analytics work and the paper-redemption job has nothing to find.
- [ ] **Investigate the cancellation rate (bug #6).** Could be reconciler config, could be real. Need clean understanding before claiming the algorithm "works."
- [ ] **Resolve `swisstony` address + add as canonical test target.** Maybe script a Polymarket-leaderboard target picker so future agents can self-select.
- [ ] **Pre-P1 smoke** (per review-design): one live→paper→live cycle on a single prod target before flipping `PAPER_ENFORCE_MODE` across `preview`. Candidate-a is done; preview is next.

### Phase B — AI-controlled accounts (the user's actual ask)

This is the agent-owns-the-algorithm phase. Pieces that don't exist yet:

- [ ] **CODEOWNERS scope.** Project doc Polish item #1 — scope `nodes/poly/app/src/features/copy-trade/**` to the AI agent's identity. Cross-cutting changes stay repo-wide review.
- [ ] **Bearer-token auth path for `poly-test.cognidao.org`.** Today the copy-trade-targets API requires Privy session cookies. Operator API bearer tokens (`cognidao.org`) don't propagate to `poly-test.cognidao.org`. An AI agent needs a service-account bearer that can POST to `/api/v1/poly/copy-trade/targets`. This is the literal blocker between "humans driving paper trading" and "AI driving paper trading."
- [ ] **Account-provisioning loop for agents.** AI needs: register, add target, set `mirror_max_usdc_per_trade`, observe, iterate. Investigate `nodes/poly/app/src/app/api/v1/poly/copy-trade/targets/route.ts` for what the agent can do via API.
- [ ] **Algorithm experimentation framework.** Agent commits → flight to candidate-a (paper-enforced) → observe N hours of paper PnL on preview → promote-or-revert decision. Today every PR's code flies on the same candidate-a slot; if multiple agents iterate concurrently this needs per-PR isolation (operator's slot-isolation work is partially designed in `task.0370`-class items).

### Phase C — Delta minimization (the harder ask)

Delta = our wallet's position vs the target wallet's position, per market. Existing `/delta-minimizer` skill investigates one specific discrepancy at a time. For autonomous delta-min in paper:

- [ ] **Position aggregation paper-awareness** (PR1 roadmap item 9, NEVER SHIPPED). `closePosition` / `exitPosition` currently call Data-API for positions on the (non-existent) paper trader wallet. Must read from `poly_copy_trade_fills WHERE mode='paper'` instead. BLOCKING for any close-position / exit-position flow under paper.
- [ ] **Paper-redemption job** (PR1 roadmap item 10, NEVER SHIPPED). `features/redeem/` is funder-scoped and chain-truth-based — paper positions have no funder. The job needs a parallel observer watching `ConditionResolution` events that stamps `poly_copy_trade_fills.position_lifecycle` for `mode='paper'` rows.
- [ ] **Delta-min loop runs against paper continuously.** Today the skill investigates one market on demand. Make it autonomous: pick a market with notable delta, propose an algorithm tweak, flight to candidate-a, observe.

## How to operate today

### See live paper trading

```bash
# Candidate-a VM SSH key
SSH_KEY=/Users/derek/dev/cogni-poly/.local/candidate-a-vm-key

# Pod state
ssh -i $SSH_KEY root@candidate-a.vm.cognidao.org \
  "kubectl -n cogni-candidate-a get pods -l app.kubernetes.io/instance=poly"

# Sidecar logs (last 50)
ssh -i $SSH_KEY root@candidate-a.vm.cognidao.org \
  "kubectl -n cogni-candidate-a logs <pod> -c poly-paper-sidecar --tail=50"

# Loki — sidecar place_order events
source .env.cogni
bash scripts/loki-query.sh \
  '{namespace="cogni-candidate-a",container="poly-paper-sidecar"} | json | event="adapter.paper_sidecar.place_order.complete"' \
  600 20

# Cross-service join on client_order_id
bash scripts/loki-query.sh \
  '{namespace="cogni-candidate-a"} |~ "<client_order_id>"' 3600 50
```

### Direct sidecar call (bypass cogni — useful for debugging the sidecar in isolation)

```bash
ssh -i $SSH_KEY root@candidate-a.vm.cognidao.org "
  kubectl -n cogni-candidate-a port-forward pod/<pod> 9100:9100 >/tmp/pf.log 2>&1 &
  sleep 2
  curl -sX POST http://localhost:9100/place-order \
    -H 'content-type: application/json' \
    -d '{\"client_order_id\":\"test-1\",
         \"market_id\":\"prediction-market:polymarket:<conditionId>\",
         \"outcome\":\"Yes\",
         \"side\":\"BUY\",
         \"size_usdc\":1,
         \"limit_price\":0.50}'"
```

### Query DB

Pattern that's worked all session (no `psql` on the VM directly):

```bash
# write a script that creates a one-off pg pod, copies a .sql file in, runs it
cat > /tmp/q.sh <<'BASH'
#!/bin/bash
PGURL='postgresql://app_service:<password>@5.199.173.155:5432/cogni_poly?sslmode=disable'
cat > /tmp/q.sql <<'SQL'
-- your query here
SQL
kubectl -n cogni-candidate-a delete pod pg-query --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
kubectl -n cogni-candidate-a run pg-query --restart=Never --image=postgres:16-alpine --command -- sleep 60 >/dev/null
sleep 3
kubectl -n cogni-candidate-a cp /tmp/q.sql pg-query:/tmp/q.sql
kubectl -n cogni-candidate-a exec pg-query -- psql "$PGURL" -f /tmp/q.sql 2>&1
kubectl -n cogni-candidate-a delete pod pg-query --grace-period=0 --force >/dev/null 2>&1
BASH
scp -i $SSH_KEY /tmp/q.sh root@candidate-a.vm.cognidao.org:/tmp/q.sh
ssh -i $SSH_KEY root@candidate-a.vm.cognidao.org "bash /tmp/q.sh"
```

Grab `PGURL` from `kubectl -n cogni-candidate-a exec deploy/poly-node-app -c app -- env | grep DATABASE_SERVICE_URL`.

### Bump the sidecar after a code change

1. Push to a branch under `infra/images/poly-paper-sidecar/**`
2. CI builds (`build-poly-paper-sidecar.yml`) publishes `sha-<short>` tag (pull_request events tag with the merge SHA, not the commit SHA — workaround if you need the commit SHA: change workflow to use `github.event.pull_request.head.sha`)
3. Grab the digest: `gh api /orgs/Cogni-DAO/packages/container/poly-paper-sidecar/versions?per_page=1 --jq '.[0].name'`
4. Edit the sidecar digest in `infra/k8s/overlays/{candidate-a,preview}/poly/kustomization.yaml`
5. PR → merge to main. If blocked by promote-k8s-image.sh sed bug (#2 above), edit `deploy/candidate-a-poly` branch directly via a `git worktree add /tmp/dfix origin/deploy/candidate-a-poly`
6. Argo auto-syncs in ≤3 min; force with `kubectl -n argocd patch app candidate-a-poly --type merge -p '{"operation":{"sync":{}}}'`

## Don't repeat these mistakes

- **Don't put the word "digest" in comments inside an `images:` block** — `promote-k8s-image.sh`'s sed will eat them.
- **Don't assume local pytest = candidate-a works.** Local pytest stubs `pm_trader.engine`. The real upstream Engine has a SQLite cross-thread restriction that local tests never hit. Test on candidate-a.
- **Don't add a target and expect mirror placements within minutes if the target trades same-day-resolution markets.** `market_past_end_date` correctly refuses; the wallet-to-mirror lag (~30s) exceeds the market lifetime.
- **Don't try to add a copy-trade target via direct DB INSERT.** Bypasses billing-account + RLS scope. Use the API (with valid session/bearer).
- **Don't assume the operator API's bearer token (`cognidao.org`) works against `poly-test.cognidao.org`.** Different domain, different session, different auth path.

## Open items I'd own first (recommendation for the next agent)

1. **Fix DB `mode` mis-attribution (bug #1).** ~30-min task. Unblocks every paper analytic.
2. **Investigate cancel rate (bug #6).** Need a clean diagnosis before claiming "algorithm working."
3. **Resolve `swisstony` and add as canonical test target.**
4. **Write the first AI-iteration loop spec.** What does the agent's contribution cycle look like end-to-end? The user's framing implies something more autonomous than today's PR-driven flow. Scope before implementing.

## Final state at handoff

- PR #56 marked `ready for review`. All CI green. Validation tables in PR body show every checked layer.
- candidate-a `poly-node-app-<pod>` running `cogni-poly@sha256:1f4e9c5f…` + `poly-paper-sidecar@sha256:e96106e8…` (or newer post-handoff).
- `deploy/candidate-a-poly` branch HEAD is the latest manual-bumped commit; CI catalog v2 work will replace the manual-bump dance.
- Paper trading is real. The plumbing is done. The algorithm is yours.
