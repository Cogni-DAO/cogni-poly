# Handoff — preview paper-trading evaluation, 2026-05-28

> Read this if you are taking over the tenant-matrix evaluation work.
> Skim time: 5 min. The goal is **evaluatable preview paper-trading**.

## Where we are right now (one paragraph)

The tenant-matrix evaluator (PR #140) now surfaces `placed / filled /
fill rate / top cancel reasons` per tenant, color-coded against
candidate-a as the healthy baseline. The 2026-05-24 preview paper-sidecar
fill-rate cliff (40% → 0.1% in one hour, lasted 70+ hours) was diagnosed
and resolved by a pod restart at 2026-05-27 17:59 UTC (concurrent with
the task.5014 deploy). **Overnight verification:** preview auto tenants
now fill at ~42%, candidate-a at 41-49% — within noise. **The fill-rate
gap is closed.** The unresolved questions are why the restart was needed
(no proven mechanism) and how to re-enable the 3 disabled position_gap
preview tenants safely.

## Current preview tenant matrix state

Active on preview right now:

| billing  | policy          | fill rate (12h) | status                                                          |
| -------- | --------------- | --------------- | --------------------------------------------------------------- |
| eae447b1 | auto p80 / $15  | 42.1%           | active (legacy "TRUST_TWIN", mis-named — see naming note below) |
| fb8f65d5 | auto p80 / $100 | 41.8%           | active                                                          |

**Disabled at 2026-05-27 17:59:38 UTC by migration 0057** (task.5014's
position_gap rewrite drops `mirror_capital_alloc_usdc` and adds
`target_range_max_usdc` + `mirror_max_alloc_per_condition_usdc`;
existing position_gap rows lacking the new knobs were force-disabled to
satisfy the new CHECK constraint):

| billing  | old policy                      | how to revive                                              |
| -------- | ------------------------------- | ---------------------------------------------------------- |
| 0e16cf1a | position_gap @ \$1k cap_alloc   | PATCH with target_range_max_usdc + max_alloc_per_condition |
| 376c594c | position_gap @ \$50k cap_alloc  | same                                                       |
| b0ca1bce | position_gap @ \$500k cap_alloc | same — this is the "SWISSTONY_BUDGET_MIRROR"               |

**Do not re-enable yet** — see "next steps" §3.

## What the matrix tool now surfaces (and what to actually look at)

Run: `pnpm tsx nodes/poly/scripts/tenant-matrix-evaluator.ts 0x204f72f35326db932158cba6adff0b9a1da95e14 --since 2026-05-28T00:00:00Z`

The Q2 algo table is the headline. Columns left-to-right: tenant → policy
→ **placed / filled / fill rate / top cancel reasons** → PnL $ → distance
to target. The new four-column block on the left tells you whether to
trust any of the financial numbers on the right.

- **Fill rate green (≥30%)** = paper sidecar is matching orders.
- **Fill rate amber (10-30%)** = degraded — half the candidate-a baseline.
  Compare cancel reasons to candidate-a to identify which mechanism
  is failing (ttl_expired = sidecar not matching; stale_resting_layer_up
  = price moved during the resting window).
- **Fill rate red (<10%)** = paper sidecar effectively dead. The 2026-05-24
  cliff would have hit this color the moment it happened. If you see
  this, the report's PnL/distance numbers are noise.
- **Cancel reason cell** is the diagnostic. The 2026-05-24 cliff was
  93% `ttl_expired` — the smoking gun for "orders placed but never
  match against the simulated CLOB."

The tool also runs `fetchEnvFreshness` (max `decided_at` per env DS) and
emits a red banner above the takeaway if any env's mirror coordinator
has been silent >1h. That's a separate signal — env outage vs. paper
fill failure — don't confuse them.

## The unresolved root-cause question

**WHY** did the preview paper-sidecar stop matching orders at 2026-05-24
19:00 UTC? Best-supported observations:

- Same code (`f620cc8c`) ran continuously from 2026-05-22 17:50 UTC
  to 2026-05-27 17:58 UTC. No deploy at the cliff.
- Candidate-a on the same code was healthy throughout. The bug is
  preview-environment-specific.
- The old pod's `self.orders` map (server.py) accumulated 3,184 "open"
  entries while pm_trader's SQLite resolved them out of pending —
  state drift between the two.
- During the cliff, fill_loop heartbeats showed `pending_count ≈ 2,400,
filled_count = 0` every 30s for 70+ hours straight.
- The pod restart at 17:59 UTC immediately restored 55% fill rate.

**Confidence on cause:**

1. ~40% — pm_trader's `_maker_fill_last_scan` cursor or HTTP keepalive
   client got into a stuck state after some external trigger.
2. ~30% — back-pressure from the 2026-05-24 10:00 UTC Grafana rate
   limit (Alloy → Grafana Cloud blocked → Pino stdout writes blocked →
   event loop pressured → fill loop's HTTP calls timed out into a
   permanent bad-state). Plausible but doesn't fully fit — fills stayed
   broken from 2026-05-27 03:00 (logs resumed) to 17:59 (restart) with
   logs flowing, so the back-pressure alone can't be sufficient cause.
3. ~20% — Polymarket Data-API rate-limited the preview VM's egress IP
   specifically.
4. ~10% — something else entirely.

None of these are validated. The old pod is gone — no heap, no
in-memory state snapshot. Reproducing the failure on a fresh pod is the
only path to a real answer.

## Naming note — purge "trust twin" misnomers

The repo uses "trust twin" to mean two different things and that
conflation cost a lot of time. The corrected definitions:

- **Fidelity twin** (THE trust twin): a paper-side tenant whose sizing
  policy + config exactly match prod LIVE. Holds algo constant;
  isolates paper-sidecar adapter fidelity. **Q1 in the matrix tool
  picks this by policy-match against prod LIVE.** Currently there is
  no such tenant configured AND prod LIVE has 0 active mirror rows,
  so Q1 reads ⚪ NOT TESTABLE. Provision one when prod resumes trading.
- **Budget mirror** (NOT a trust twin): `POLY_PREVIEW_TENANT_SWISSTONY_TRUST_TWIN`
  (billing b0ca1bce) runs position_gap @ $500k to model swisstony's
  book size. Different policy than prod LIVE. The tool aliases its
  display label to `SWISSTONY_BUDGET_MIRROR`. The env-block rename in
  `.env.cogni` is a follow-up.
- **Policy variant**: any other paper tenant (different policy or
  sizing). Useful for Q2 ranking, not Q1 fidelity.

If anyone calls a non-policy-matched tenant a "trust twin", correct
them. It is the single most common misdiagnosis vector.

## Next steps, ranked by leverage

### 1. Validate preview is still healthy after 24h (low cost, immediate)

Run the matrix tool tomorrow morning. If preview auto tenants are still
40-50% fill rate, the fix is durable. If degradation has returned,
**that itself is the validation** that the bug is recurring — capture
sidecar state BEFORE restart:

```bash
# Get the SQLite + the in-process self.orders map count
PREVIEW=$(cat ~/dev/cogni-poly/.local/preview-vm-ip)
KEY=~/dev/cogni-poly/.local/preview-vm-key
POD=$(ssh -i $KEY root@$PREVIEW 'kubectl -n cogni-preview get pod -l app.kubernetes.io/name=poly-node-app -o jsonpath={.items[0].metadata.name}')

# Sidecar SQLite snapshot
ssh -i $KEY root@$PREVIEW "kubectl -n cogni-preview exec $POD -c poly-paper-sidecar -- \
  python3 -c \"import sqlite3; c=sqlite3.connect('/tmp/pm_trader/cogni-paper/paper.db'); \
  [print(r) for r in c.execute('SELECT status, COUNT(*) FROM limit_orders GROUP BY 1')]\""

# Recent fill_loop heartbeats — pending vs filled per tick
ssh -i $KEY root@$PREVIEW "kubectl -n cogni-preview logs --tail=200 $POD -c poly-paper-sidecar | grep 'tick_complete' | tail -10"
```

If `pending_count` is high and `filled_count = 0` for many minutes,
that's the cliff state. Snapshot, then restart, then compare. **That
diff is the test that distinguishes theory 1 from theories 2-4.**

### 2. Instrument the sidecar (one PR — gives us a chance next time)

Three changes in `nodes/poly/sidecars/paper-trader/server.py` +
`vendor/pm_trader/pm_trader/engine.py`:

- Per-tick add `sqlite_pending_count` to the heartbeat (currently only
  `self.orders` count is logged). When the two diverge, drift is
  obvious immediately.
- Log `_maker_fill_last_scan` cursor lag (now - cursor_ts) on every
  maker_fill_scan event. If the cursor is stuck, it shows up.
- Bound the `_maker_fill_last_scan` cursor to `now - LAG_BUFFER`
  unconditionally (currently it only advances on exception path). A
  cursor stuck in the distant past silently breaks fills.

None of these prevent the bug, but next time it happens the cause is
in the logs instead of in a dead pod.

### 3. Re-register position_gap tenants (after #1 verifies stability)

Three tenants need PATCH against
`https://poly-preview.cognidao.org/api/v1/poly/copy-trade/targets/{id}`
with the new range knobs. Owner: whoever has the relevant API keys for
those env blocks. **Do not do this before #1 confirms 24h of stable
fill rate.** Re-enabling now risks another cliff-period of
ttl_expired noise that pollutes the matrix.

### 4. Provision a fidelity twin when prod resumes (low priority while prod disabled)

Q1 is ⚪ NOT TESTABLE because prod LIVE has 0 active mirror rows and no
preview tenant policy-matches what prod LIVE would run. When prod
resumes trading:

1. Read prod LIVE's `sizing_policy_kind, mirror_max_usdc_per_trade,
mirror_max_alloc_per_condition_usdc, mirror_filter_percentile`.
2. Provision a preview tenant with the identical 4-tuple.
3. The matrix tool auto-picks it as the fidelity twin (no flag needed —
   it scans by exact match).
4. Q1 then becomes ✅/⚠/❌ based on how closely the twin tracks prod LIVE
   on shared markets.

## Things NOT to do

- **Don't trust "trust twin" — see naming note.** `SWISSTONY_TRUST_TWIN`
  is a budget mirror, not a fidelity twin. The matrix tool aliases the
  display; the env var still misleads.
- **Don't restart the sidecar on a cron as a "fix"** — it's a bandaid
  for an unknown bug. Capture state first (§1).
- **Don't re-enable position_gap before §1 is verified** — you'll
  produce another window of TTL-expired noise.
- **Don't query the matrix over a window that spans the 2026-05-24
  cliff and call it a "ranking"** — the aggregated PnL/fill numbers
  there are unsafe. Either window after 2026-05-27 17:59 UTC or call
  out the bias.

## Files to read first

- `nodes/poly/research/preview-data-health-2026-05-27.md` — the prior
  diagnostic write-up (Timeline A / B separation, raw queries used).
- `nodes/poly/scripts/tenant-matrix-evaluator.ts` — the tool. Read the
  header invariants block + `fetchTenantFillsAgg` for the fill-rate
  math.
- `nodes/poly/app/src/features/trading/order-ledger.ts` (header
  comment) — `REALIZED_COLUMNS_WRITTEN` invariant (bug.5018).
- `nodes/poly/sidecars/paper-trader/server.py:394` (`_fill_loop`) +
  `nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/engine.py:474`
  (`check_orders`) — where the fill matching actually happens.
- `docs/research/poly/range-relative-mirror-2026-05-26.md` — task.5014
  design doc; explains the new position_gap knobs.

## Pointers to the relevant PRs

- **PR #140** (this branch, open) — tenant-matrix-evaluator refactor;
  contains the fill-rate / cancel-reason columns and the prior
  diagnostic.
- **PR #141** (merged) — task.5014 position_gap rewrite + migration 0057.

## How to validate the matrix tool itself

If you don't trust the tool (and after the prior round of "is it
fine?" you shouldn't trust it blindly):

```bash
# Compare the tool's fill-rate column to direct psql
PREVIEW=$(cat ~/dev/cogni-poly/.local/preview-vm-ip)
KEY=~/dev/cogni-poly/.local/preview-vm-key
ssh -i $KEY root@$PREVIEW "docker exec cogni-runtime-postgres-1 psql -U postgres -d cogni_poly -c \"
SELECT LEFT(billing_account_id,8) AS bill8,
  COUNT(*) FILTER (WHERE status='filled') AS filled,
  COUNT(*) FILTER (WHERE status IN ('filled','canceled','error')) AS placed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status='filled') /
    NULLIF(COUNT(*) FILTER (WHERE status IN ('filled','canceled','error')), 0), 1) AS fill_pct
FROM poly_copy_trade_fills
WHERE billing_account_id IN (
  SELECT billing_account_id FROM poly_copy_trade_targets
  WHERE LOWER(target_wallet)=LOWER('0x204f72f35326db932158cba6adff0b9a1da95e14'))
  AND observed_at >= '2026-05-28T00:00:00Z'::timestamptz
GROUP BY 1 ORDER BY 1\""
```

The numbers should match the algo table's `placed` / `filled` / `fill
rate` columns for the same window. If they don't, the tool is lying;
file a bug and don't ship findings based on it.

---

**Bottom line for the next dev:** the immediate fire is out (preview is
filling at parity with candidate-a overnight). The next durable win is
instrumenting the sidecar (§2) so when the cliff recurs we don't have to
do a 70-hour archaeology again. Then re-enable position_gap (§3).
Q1 (true fidelity test) waits on prod resuming.
