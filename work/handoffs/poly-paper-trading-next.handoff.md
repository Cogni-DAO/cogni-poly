---
id: poly-paper-trading-next.handoff
type: handoff
work_item_id: proj.poly-paper-trading
status: active
created: 2026-05-17
branch: derekg1729/poly-paper-sidecar-order-id-fix (off main, ready for next dev)
---

# Handoff — Cogni-Poly Paper Trading, Next Steps

## TL;DR

Paper trading was the goal of this session. We didn't get there — we got pulled into fixing the underlying data layer first. The work that landed makes paper trading _possible_; one focused PR ahead of you actually makes it _useful_.

## What just got built (and why it doesn't ship paper trading by itself)

| PR  | Status                | What it did                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Why it was on the path                                                                                                                                                                                  |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #62 | merged `75c8adf14`    | `PAPER_DISPATCH_IS_ENV_ONLY` — removed the per-target paper trapdoor from `buildExecutor`. PROD is now live-only by construction. Includes the `mode='paper'` DB-stamping fix originally on the closed #60.                                                                                                                                                                                                                                                                                                                              | Latent foot-gun where a DB column flip could silently route real-money placements to the paper sidecar. Closed before doing anything else.                                                              |
| #98 | in flight (task.5003) | `MODE_STAMPED_AT_LEDGER_FROM_ENV` — the order-ledger is now the single write authority for `poly_copy_trade_{fills,decisions}.mode`. Drops the dead echoes (`targets.mode` column via migration 0053, `MirrorTargetConfig.mode`, `intent.attributes.mode`, `mode_paper` `MirrorReason`). No retroactive backfill — the JSONB join key (`decisions.intent->>'mode' = 'paper'`) cannot distinguish paper execution from a PROD-era manual target PATCH, so pre-cutover rows stay labeled `'live'` and analytics rebuild from new activity. | #62 left the column-write side broken — every paper row still got DB default `'live'`. `?mode=paper` returned zero on cand-a. Closes the analytics gap that blocked paper-PnL trust **going forward**.  |
| #63 | merged `f45ef8d63`    | `/api/v1/poly/copy-trade/orders` is now `billing_account_id`-scoped. Required field on `ListRecentOptions` — can't accidentally regress. `mode` field surfaced in the response.                                                                                                                                                                                                                                                                                                                                                          | Otherwise every authenticated caller sees every tenant's ledger. Blocks the multi-tenant experimentation MVP.                                                                                           |
| #66 | merged `ac2e03c904`   | Multi-tenant fills PK + per-tenant `client_order_id` + `placed_fill_ids` safety backstop in plan-mirror. Migration `0050_multi_tenant_fills_pk.sql` widens the PK on `poly_copy_trade_fills` to `(billing_account_id, target_id, fill_id)`.                                                                                                                                                                                                                                                                                              | Validator-A/B test during #63 validation surfaced a silent `ON CONFLICT DO NOTHING` drop — only one tenant per `(target, fill)` was getting a row. Data layer was structurally broken for multi-tenant. |

All three are correctness work. None of them, by themselves, makes paper trading produce a usable PnL signal.

## The single actual paper-trading blocker

**Sidecar `order_id` collisions.** On candidate-a right now, Derek's tenant has **0 filled / 137 canceled-or-error** paper rows. Every paper fill errors at the cogni-side `UPDATE`. Root cause:

- The paper sidecar wraps `pm_trader.Engine`, which uses an autoincrement SQLite PK for `order_id`.
- `pm_trader`'s SQLite lives at `/tmp/pm_trader/cogni-paper/` — wiped on every pod restart.
- After a restart, the sidecar returns `order_id = 1, 2, 3, ...` again. Cogni Postgres has rows for `order_id = 1..N` from earlier boots, protected by `poly_copy_trade_fills_order_id_unique` (partial unique index on `order_id WHERE order_id IS NOT NULL`).
- Cogni's reconciler does `UPDATE poly_copy_trade_fills SET order_id = ? ...` — fails with PG `23505` unique-violation. The fill is marked `status='error'`.

**Fix — sidecar-side only, one file:**

- `infra/images/poly-paper-sidecar/server.py` — after getting `order_id` from `Engine.place_limit_order`, prefix it with a per-process identifier so it's globally unique across boots. Two natural options:
  1. Generate a process-startup UUID4 prefix: `f"{BOOT_ID}_{engine_order_id}"`
  2. Embed the process start epoch (ms): `f"{BOOT_EPOCH_MS}_{engine_order_id}"`
- Then bump the sidecar image digest in `infra/k8s/overlays/{candidate-a,preview}/poly/kustomization.yaml`. No cogni-side change needed (cogni already stores `order_id` as `text`).
- Sidecar bump procedure: see `infra/images/poly-paper-sidecar/AGENTS.md`. CI workflow `build-poly-paper-sidecar.yml` publishes the new image, then update digests via the catalog v2 flow (per PR #61 — `feat(ci): catalog v2`).

Until this lands, no `mode='paper'` PnL number is trustworthy. **This is the absolute next thing.**

## After the sidecar fix: the MVP plan resumes

`work/projects/proj.poly-paper-trading.md` has the full plan. Compressed:

1. **Phase 1 — trust anchor** (no code, ~1 day to set up, 1 week to observe).
   - Register a bearer-auth agent on `poly-preview` (env-paper).
   - `POST /api/v1/poly/copy-trade/targets` for swisstony `0x204f72f35326db932158cba6adff0b9a1da95e14`.
   - `PATCH` it to Derek's exact PROD config: `mirror_filter_percentile=80, mirror_max_usdc_per_trade=15`.
   - Compare daily PnL vs Derek's PROD swisstony PnL. Both poll the same external wallet, so divergence > ~10% = a real paper-trading bug to chase.

2. **Phase 2 — N concurrent experimental tenants** (no code beyond Phase 0).
   - One bearer + one target config per agent on `poly-preview`. Knob space (today, without new code): `mirror_filter_percentile ∈ {50,75,80,90,95,99}` × `mirror_max_usdc_per_trade ∈ {5,15,30}` × `target_wallet ∈ {swisstony, RN1}`.
   - Trust-twin is the baseline. Sustained-outperformance configs become promotion candidates.
   - **Promotion = `PATCH` Derek's PROD `poly_copy_trade_targets` row.** That's the entire deploy mechanism. The data layer is already isolated.

3. **Phase 3 — knob expansion** (only if Phase 2 hits a ceiling).
   - Hardcoded knobs in `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts`: pXX ladder values for swisstony/RN1, position-followup defaults (min_mirror_position_usdc, market_floor_multiple, hedge ratios). Each becomes a per-target DB column + PATCH-route field.
   - Don't preemptively promote — let experimental signal drive it.

4. **Phase 4 — `/delta-minimizer` spikes against paper.**

## Mental model (verified as of 2026-05-17)

- **Three environments, three behaviors:**
  - PROD (`poly.cognidao.org`) — live trading. `PAPER_ENFORCE_MODE` unset. `buildExecutor` is live-only by construction. No paper sidecar deployed; no path routes to paper from PROD.
  - candidate-a (`poly-test.cognidao.org`) — `PAPER_ENFORCE_MODE=paper`. Sidecar deployed. `buildPaperOnlyExecutor` selected at construction.
  - preview (`poly-preview.cognidao.org`) — same envelope as candidate-a, more stable (no per-PR rebuilds).

- **Multi-tenant works at the data layer** (#66 merged 2026-05-17 02:16 UTC, on main + preview + candidate-a; PROD is at `789ac8600` — PROD does NOT yet have #66, see "PROD lag" below):
  - Every copy-trade table is `billing_account_id`-scoped with RLS.
  - `poly_copy_trade_fills` PK is `(billing_account_id, target_id, fill_id)` — N tenants on the same wallet's same fill get N independent rows.
  - `clientOrderIdFor(billing_account_id, target_id, fill_id)` — pinned 3-arg helper. CLOB-side placements never share idempotency keys across tenants.
  - Plan-mirror's `already_placed` gate checks both `client_order_id` AND `(target, fill)` membership — survives the COID shape migration; no phantom placements on cursor regression.

- **Auth — agent-first, already wired:**
  - `POST /api/v1/agent/register {name}` mints a 30-day HMAC bearer (`cogni_ag_sk_v1_...`) + `billing_account_id`.
  - `resolveRequestIdentity` does bearer-first → session-cookie fallback. All `/api/v1/poly/copy-trade/*` routes accept either.
  - Bearer is HMAC-signed per environment with `AUTH_SECRET`. **Do NOT expect a `cognidao.org` token to work on `poly-test.cognidao.org` (or vice versa).**

## How to use the system today

```bash
# Register a fresh tenant (poly-preview is the steady paper env)
curl -X POST https://poly-preview.cognidao.org/api/v1/agent/register \
  -H 'content-type: application/json' -d '{"name":"my-agent"}'
# → {userId, apiKey, billingAccountId}

# Add a target wallet
curl -X POST https://poly-preview.cognidao.org/api/v1/poly/copy-trade/targets \
  -H "Authorization: Bearer cogni_ag_sk_v1_..." \
  -H 'content-type: application/json' \
  -d '{"target_wallet":"0x204f72f35326db932158cba6adff0b9a1da95e14"}'
# → {target.target_id, ...}

# Tune the per-target config
curl -X PATCH https://poly-preview.cognidao.org/api/v1/poly/copy-trade/targets/<target_id> \
  -H "Authorization: Bearer ..." \
  -H 'content-type: application/json' \
  -d '{"mirror_filter_percentile":80, "mirror_max_usdc_per_trade":15}'

# Read your own (and only your own) orders
curl https://poly-preview.cognidao.org/api/v1/poly/copy-trade/orders \
  -H "Authorization: Bearer ..."
```

## Observability cheatsheet

```bash
source .env.cogni
# Per-tenant placement rate
bash scripts/loki-query.sh \
  '{namespace="cogni-candidate-a"} | json | event="poly.mirror.place.tenant" | billing_account_id="<id>"' \
  600 50

# Decision-loop skip-reason histogram
bash scripts/loki-query.sh \
  'sum by (reason) (count_over_time({namespace="cogni-candidate-a"} | json | event="poly.mirror.decision" [1h]))' \
  3600 50

# Tenant DB state (Grafana Postgres datasource)
bash scripts/grafana-postgres-query.sh \
  "select status, mode, count(*) from poly_copy_trade_fills where billing_account_id='<id>' group by status, mode" \
  --env candidate-a --node poly
```

## PROD lag (verified 2026-05-17)

| env                                    | sha                               | has #66? |
| -------------------------------------- | --------------------------------- | -------- |
| prod (`poly.cognidao.org`)             | `789ac8600` (= PR #61 catalog v2) | **NO**   |
| preview (`poly-preview.cognidao.org`)  | `ac2e03c904` (= PR #66 merge)     | yes      |
| candidate-a (`poly-test.cognidao.org`) | `2a69c1772` (PR #66 flight head)  | yes      |
| main HEAD                              | `ac2e03c904`                      | yes      |

**Is PROD's lag urgent?** Today, NO. Derek is the only PROD user — single-tenant. Pre-#66 code works correctly for single-tenant: stored COIDs match newly-computed COIDs (both 2-arg), no phantom placements possible, no PK collisions. The `(target_id, fill_id)` PK only fails when N tenants collide on the same key.

**When PROD's lag becomes blocking:** the day a second PROD billing account exists (e.g., promoting a winning preview config onto PROD as a shadow-PnL tenant). Then #66 must be on PROD first. Promotion is an explicit separate workflow (see the `promote` skill in `.claude/skills/promote/`).

## Open follow-ups (file as bugs when you start)

1. **Sidecar `order_id` collision** — THE actual paper-trading blocker (above). Highest priority.
2. **Reconciler stop-logic on soft-deleted targets** — soft-deleted target rows (`disabled_at IS NOT NULL`) continue emitting `place.tenant` events for ~hours. Stop signal isn't reaching the running poll cleanly. Surfaced during PR #66 validation.
3. **Mode mis-attribution on pre-#62 candidate-a rows** — the 137 stranded rows on Derek's tenant have `mode='live'`. Mostly harmless because they're terminal status; just analytics noise. Could be cleaned up with a one-shot SQL update if needed.
4. **`wallet-analysis/*.int.test.ts` flake** — `market-outcome-tick.int.test.ts` and `price-history-service.int.test.ts` show fixture pollution under the parallel testcontainer suite. "100 vs 5" / "104 vs 3" asserts. Tests share `getSeedDb()` and don't filter `runMarketOutcomeTick`'s discovery query by the seeded wallet — anyone else's seed rows are picked up. Has retried-to-green twice; will keep biting until fixed.

## Don't repeat these mistakes (from this session)

1. **NEVER `gh pr merge --auto` before flight + `/validate-candidate`.** The merge queue ignores subsequent `--undo` and the PR auto-merges. PR #62 and PR #63 both merged before validation in this session — the contract from CLAUDE.md is **flight → validate → merge**, not the other way around. The merge queue is non-bypassable.

2. **Stale handoffs lie.** A prior handoff at `work/handoffs/ai-controlled-paper-config.handoff.md` (deleted this session) claimed `/copy-trade/config` exists and bearer auth was missing. Both false. Verify every claim with `git grep` / `gh pr view` evidence before trusting.

3. **`target_id` in different contexts means different things.**
   - In `poly_copy_trade_targets` rows + the API response from `POST /copy-trade/targets`: per-tenant DB row PK (`uuid4`).
   - In `poly_copy_trade_fills.target_id` + `poly_copy_trade_decisions.target_id`: `uuidv5(target_wallet)` — deterministic, shared across tenants.
   - Same name, different value. Don't conflate.

4. **Existing DB rows can mismatch new code shape.** When `clientOrderIdFor` got a new arg, every pre-existing row had a now-mismatched stored COID. Without the `placed_fill_ids` backstop (added in #66), this caused real phantom placements after deploy. **If you change any deterministic key shape in this codebase, audit every code path that does set-membership against stored values.**

5. **`/version` is the source of truth for deployed code.** Always confirm `buildSha` matches the PR head before claiming `deploy_verified`. The candidate-flight workflow's `pr_number=N` resolves to the PR's current HEAD by default — pass `head_sha=` explicitly if you want a specific commit.

## Pinned invariants (search for these in code)

- `PAPER_DISPATCH_IS_ENV_ONLY` — `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts`. The env is the only paper switch.
- `IDEMPOTENT_BY_CLIENT_ID` — 3-arg `(billing, target, fill)`. `nodes/poly/packages/market-provider/src/domain/client-order-id.ts` pinned helper.
- Multi-tenant fills PK `(billing_account_id, target_id, fill_id)` — `nodes/poly/packages/db-schema/src/copy-trade.ts:173–175`.
- `TENANT_SCOPED` on `/copy-trade/orders` — route docstring + `billing_account_id` required field on `ListRecentOptions`.
- `placed_fill_ids` backstop — `nodes/poly/app/src/features/copy-trade/plan-mirror.ts:212`. The actual idempotency key; COID is fast-path proxy.

## Key files

| File                                                               | Why                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts`       | The mirror loop config. Hardcoded swisstony+RN1 pXX ladder. Edit-and-reflight to tune.                             |
| `nodes/poly/app/src/features/copy-trade/mirror-pipeline.ts`        | The decision engine. Loki fields emitted here.                                                                     |
| `nodes/poly/app/src/features/copy-trade/plan-mirror.ts`            | Pure planner. `already_placed` gate (line 212 area) + branch decisions.                                            |
| `nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts` | `buildExecutor` (live, PROD) vs `buildPaperOnlyExecutor` (paper, env-paper). Chosen ONCE at executor construction. |
| `infra/images/poly-paper-sidecar/server.py`                        | The FastAPI sidecar wrapping pm_trader.Engine. **Sidecar order_id fix lives here.**                                |
| `infra/images/poly-paper-sidecar/AGENTS.md`                        | Sidecar runtime contract + bump-the-sidecar workflow.                                                              |
| `infra/k8s/overlays/{candidate-a,preview}/poly/kustomization.yaml` | Where to bump the sidecar image digest.                                                                            |
| `work/projects/proj.poly-paper-trading.md`                         | Full project plan (Current Status + Phase 1–4).                                                                    |
