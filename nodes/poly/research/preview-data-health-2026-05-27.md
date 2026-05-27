# Preview data-health timeline — 2026-05-27

> Dual-track analysis of preview's tenant-matrix data health. Separates
> Timeline A (Grafana access) from Timeline B (Postgres writeback). The
> handoff conflated them; the verified picture is different from both
> the handoff's hypothesis and the prior reviewer's.

## TL;DR

1. **`bug.5018` contract is intact.** Every row with `status IN ('filled', 'partial')` has `price` and `shares` populated. 100% match across all 5 preview tenants and ~6k rows over the window. There is **no realized-column writeback regression.**
2. **The "$0 realized overnight" symptom is real but mis-diagnosed.** Three preview position_gap tenants have ~3,800 rows since 2026-05-26 23:00 — every single one has `status='canceled'` with `reason='ttl_expired'` (93%) or `'stale_resting_layer_up'` (7%). 96 actual fills landed; all 96 wrote realized columns correctly. The matrix-evaluator's `SUM(price*shares) FILTER (WHERE status IN ('filled','partial'))` is **mathematically correct** — it returns 0 because almost nothing reached filled status, not because the writeback dropped values.
3. **Real cliff was 2026-05-24 19:00 UTC, not 2026-05-26 23:00.** Hourly data on preview shows fill rate collapsing from ~40% to <1% in a single hour on 2026-05-24 between 18:00 and 19:00. No code deploy, no migration, no pod restart at that time — preview was running the same `f620cc8c` image since 2026-05-22 17:50 UTC. **This is an environmental/sidecar-state regression, not a code regression.**
4. **Candidate-a is healthy.** Same code, same target, same window: 54% fill rate (695/1281 placed reach `filled`). 100% bug.5018 writeback. The cliff is **preview-specific** — confirms paper-sidecar / preview-VM state, not application code.
5. **Migration 0057 ran 2026-05-26 21:50:57 UTC** (per `__drizzle_migrations`), not 2026-05-27 17:59:38 as the handoff stated. 17:59:38 is when the _position_gap tenant rows were soft-disabled_ — separate operator action that the deploy of task.5014 triggered.

**Conclusion:** No PR to the matrix-evaluator or order-ledger is needed. The
operationally-urgent work is investigating why the preview paper-sidecar's
fill rate collapsed at 2026-05-24 19:00 UTC and stayed at ~2% through the
position_gap-disable cutoff. That is the bug.

## Timeline A — Grafana access health

| Timestamp (UTC)          | Event                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≤ 2026-05-26 (user-ack)  | Grafana free-tier rate limit was throttling tenant-matrix-evaluator queries. Empty result sets / 429s when running over wide windows.                                  |
| 2026-05-26 (user-ack)    | User upgraded Grafana plan. Throttle removed. **Resolved.**                                                                                                            |
| 2026-05-27 (this report) | Direct re-query via Grafana DS (`cogni-preview-poly-postgres`): `SELECT MAX(decided_at) FROM poly_copy_trade_decisions` returns `2026-05-27 22:54+`. Fully responsive. |

Timeline A is closed. The previous "preview env stale 49h" finding from the
2026-05-26 evaluator runs **was an artifact of the rate limit**, not a real
env outage — preview wallet-watch + mirror coordinator both kept writing
into Postgres throughout, the read-path was just throttled.

## Timeline B — Postgres writeback health (the real bug)

All queries below: ran direct via `psql` inside `cogni-runtime-postgres-1` on
the preview VM. No Grafana, no rate limit.

### B.1 — Filtered partition

Every metric below restricts to billing accounts running a swisstony target:

```sql
billing_account_id IN (
  SELECT billing_account_id FROM poly_copy_trade_targets
  WHERE LOWER(target_wallet) = LOWER('0x204f72f35326db932158cba6adff0b9a1da95e14')
)
```

Yields 5 tenants on preview: `0e16cf1a`, `376c594c`, `b0ca1bce` (position_gap),
`eae447b1`, `fb8f65d5` (auto).

### B.2 — Per-day fill counts + realized population (last 10 days)

| billing  | day        | fills | with_realized | pct  | realized_usdc                        |
| -------- | ---------- | ----- | ------------- | ---- | ------------------------------------ |
| 0e16cf1a | 2026-05-20 | 769   | 295           | 38.4 | 1,453                                |
| 0e16cf1a | 2026-05-21 | 587   | 284           | 48.4 | 1,558                                |
| 0e16cf1a | 2026-05-22 | 503   | 217           | 43.1 | 1,217                                |
| 0e16cf1a | 2026-05-23 | 580   | 290           | 50.0 | 1,250                                |
| 0e16cf1a | 2026-05-24 | 655   | 233           | 35.6 | 1,023                                |
| 0e16cf1a | 2026-05-26 | 42    | 0             | 0.0  | 0                                    |
| 0e16cf1a | 2026-05-27 | 554   | 0             | 0.0  | 0                                    |
| 376c594c | 2026-05-22 | 380   | 140           | 36.8 | 6,462                                |
| 376c594c | 2026-05-23 | 2682  | 1206          | 45.0 | 61,973                               |
| 376c594c | 2026-05-24 | 3225  | 1027          | 31.8 | 49,124                               |
| 376c594c | 2026-05-26 | 150   | 0             | 0.0  | 0                                    |
| 376c594c | 2026-05-27 | 1125  | 0             | 0.0  | 0                                    |
| b0ca1bce | 2026-05-23 | 3317  | 1544          | 46.5 | 400,983                              |
| b0ca1bce | 2026-05-24 | 4093  | 1324          | 32.3 | 381,615                              |
| b0ca1bce | 2026-05-26 | 157   | 0             | 0.0  | 0                                    |
| b0ca1bce | 2026-05-27 | 1365  | 0             | 0.0  | 0                                    |
| eae447b1 | 2026-05-23 | 189   | 100           | 52.9 | 263                                  |
| eae447b1 | 2026-05-24 | 473   | 131           | 27.7 | 354                                  |
| eae447b1 | 2026-05-27 | 259   | 38            | 14.7 | 83 + (post-deploy: 36 fills @ 100%)  |
| fb8f65d5 | 2026-05-23 | 470   | 268           | 57.0 | 1,022                                |
| fb8f65d5 | 2026-05-24 | 829   | 307           | 37.0 | 1,205                                |
| fb8f65d5 | 2026-05-27 | 313   | 61            | 19.5 | 209 + (post-deploy: 60 fills @ 100%) |

The day-aggregate "0% realized" pattern hides the real cliff. Hourly data:

| hr (UTC)             | fills   | with_realized | pct     |
| -------------------- | ------- | ------------- | ------- |
| 2026-05-24 17:00     | 676     | 269           | 39.8    |
| 2026-05-24 18:00     | 760     | 179           | 23.6    |
| **2026-05-24 19:00** | **949** | **1**         | **0.1** |
| 2026-05-24 20:00     | 886     | 2             | 0.2     |
| 2026-05-24 21:00     | 210     | 0             | 0.0     |

**Cliff is at 2026-05-24 19:00 UTC.** Within one hour, realized-column
population fell from 23.6% to 0.1%.

### B.3 — Status distribution shows the cliff is about fill rate, not writeback

```
Pre-cliff (2026-05-23 → 2026-05-24 19:00 UTC):
  filled:   5,957 | with_price: 5,957 (100%)
  canceled: 8,425 | with_price:   470 (5.6%, partial-fills)
  error:        1 | with_price:     0

Post-cliff (2026-05-26 23:00 → 2026-05-27 17:59 UTC, position_gap still active):
  filled:      96 | with_price:    96 (100%)
  canceled: 3,809 | with_price:     4 (0.1%)
  error:       77 | with_price:     0

Cancel reasons post-cliff:
  ttl_expired:            3,551 (93%)
  stale_resting_layer_up:   258 (7%)
```

**Every row with `status='filled'` has `price` and `shares` populated.** The
`bug.5018` REALIZED_COLUMNS_WRITTEN invariant in
`nodes/poly/app/src/features/trading/order-ledger.ts:19` is honored.

**Fill rate dropped from 41% to 2.4%**. Orders are being placed but not
matching the paper-sidecar's simulated orderbook within the 2-minute TTL
(`DEFAULT_TTL_MINUTES` in
`nodes/poly/app/src/bootstrap/jobs/poly-mirror-resting-sweep.job.ts:52`).

### B.4 — Cross-env A/B confirms preview-specific

Same code (`f620cc8c` → `218fa6a3`), same target, same time window
(2026-05-26 23:00 onward):

| env         | filled | canceled | error | fill rate |
| ----------- | ------ | -------- | ----- | --------- |
| preview     | 96     | 3,809    | 77    | 2.4%      |
| candidate-a | 695    | 578      | 8     | **54.2%** |

Candidate-a writes realized columns on 100% of filled rows. The bug is
preview-environment-state, not application code.

### B.5 — Current state (post-task.5014 deploy)

After `218fa6a3` (task.5014) deployed at 2026-05-27 17:58 UTC + migration 0057
soft-disabled all 3 position_gap tenants at 17:59:38 UTC, preview is running
2 auto tenants only:

| billing  | filled | canceled | fill rate | with_realized |
| -------- | ------ | -------- | --------- | ------------- |
| eae447b1 | 36     | 33       | 52%       | 100%          |
| fb8f65d5 | 60     | 53       | 53%       | 100%          |

The 2 remaining auto tenants are healthy. Fill rate matches candidate-a.
**bug.5018 contract is intact in the most-recent rows.** The position_gap
tenants need re-registration with the new range knobs (`target_range_max_usdc`

- `mirror_max_alloc_per_condition_usdc`) before they can resume — that is the
  operator action documented in PR #141.

## Root-cause assignment

For the user-reported "realized_size_usdc = $0 in matrix report":

| Tenant   | Reason for $0 realized in overnight window                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0e16cf1a | (1) Disabled at 2026-05-27 17:59:38 UTC by migration 0057. (2) Before disable, placed ~590 orders since 2026-05-26 23:00 — **all canceled (ttl_expired)** before reaching filled status. |
| 376c594c | Same shape as 0e16cf1a: disabled, and before disable all ~1,300 placements canceled.                                                                                                     |
| b0ca1bce | Same shape as 0e16cf1a: disabled, and before disable all ~1,500 placements canceled.                                                                                                     |
| eae447b1 | Active. ~70 fills overnight, $79 realized. Realized columns populated 100% on `filled` rows. **Matrix-evaluator reads correct number.**                                                  |
| fb8f65d5 | Active. ~110 fills overnight, $208 realized. Realized columns populated 100%. **Matrix-evaluator reads correct number.**                                                                 |

**None of the candidate hypotheses from the handoff match the data:**

- ❌ "paper-sidecar isn't returning realized values → markOrderId leaves columns NULL." Falsified: all 96 + 96 post-cliff filled rows have realized columns populated.
- ❌ "new placement intent malforms data → CLOB receipt is wrong → realized columns NULL." Falsified: when receipts come back, columns are written.
- ❌ "fills written to a different table or attributes-JSONB path post-task.5014." Falsified: same `poly_copy_trade_fills` table, same first-class columns, same path; row count + write rate confirm.
- ✅ The actual cause: **paper-sidecar fill rate on preview collapsed at 2026-05-24 19:00 UTC** (preview-specific, no concurrent code change). 97% of placements TTL-expire. The matrix evaluator faithfully reports the result of that.

The 5dfc72ae6 hypothesis ("guard baseline write on target_position hydration
failure → `sumTargetConditionUsdc(undefined)` returns 0 and persists") is
about the **position_gap baseline write to `poly_copy_target_condition_baseline`**,
not realized columns on `poly_copy_trade_fills`. It is the right concern for
position_gap correctness but unrelated to the user's "realized=$0" symptom.

## Fix proposal

**No PR to the matrix-evaluator or order-ledger is required.** The tool is
correctly reporting reality.

### Recommended operational follow-ups (separate work)

1. **Investigate preview paper-sidecar fill-rate collapse at 2026-05-24 19:00 UTC.**
   - File a `bug` with `node=poly` against `https://poly.cognidao.org/api/v1/work/items`.
   - Suspects in priority order:
     - Paper-sidecar in-memory orderbook cache went stale or out-of-sync. The current pod (`poly-paper-sidecar` container ID `5f18efaf...`) restarted with the poly-node-app at 2026-05-27 17:59 UTC — i.e. AFTER the cliff. The previous instance (running during the cliff) is gone, so post-mortem must come from Loki logs.
     - Polymarket Data API path / data freshness on preview specifically (bug.5025 era).
     - Maker-fill price intersection logic (`fix(poly/paper-trader): bug.5016 — fill at limit_price, not trade/book price (#121)`) regressed against post-2026-05-24 market behavior.
2. **Re-register the 3 disabled position_gap tenants** with the new schema knobs only after step 1's fix lands. Re-enabling now will produce another window of TTL-expired placements.
3. **Surface fill rate + cancel-reason breakdown in the tenant-matrix-evaluator's algo table** (small follow-up PR, ~30 lines). Add columns: `placed`, `filled`, `canceled (ttl)`, `canceled (stale)`, `fill_rate %`. Today the evaluator only shows `filled_count` and `realized_usdc`; the human can't see the difference between "no orders placed" and "many orders placed but all canceled". Doing this would have caught the cliff hours earlier.

### Linkback (per handoff done-condition)

- **Timeline status:** Timeline A (Grafana) resolved. Timeline B (Postgres) shows bug.5018 contract intact + a 2026-05-24 19:00 UTC preview paper-sidecar fill-rate collapse — independent of any code deploy.
- **Root cause:** preview paper-sidecar (or upstream Polymarket data path) regression — environmental, not code. 100% of `filled` rows write realized columns correctly; the symptom is fill rate, not writeback.
- **Next PR:** **none required against the matrix-evaluator.** Operational follow-up: investigate the preview paper-sidecar fill-rate collapse, then re-register position_gap tenants. Optional small PR to surface fill rate + cancel reasons in the matrix-evaluator's algo table (recommended, not blocking).
