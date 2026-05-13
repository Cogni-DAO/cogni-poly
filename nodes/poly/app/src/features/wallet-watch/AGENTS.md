# wallet-watch · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Generic Polymarket wallet observation primitive. Emits normalized `Fill[]` for a watched wallet since a prior cursor. Consumed by the mirror-coordinator (CP4.3d) today; any future feature that needs to observe a Polymarket wallet (PnL tracker, research tool, audit view) plugs in here without importing copy-trade vocabulary.

## Pointers

- [task.0315 — Phase 1 plan](../../../../../../work/items/task.0315.poly-copy-trade-prototype.md)
- [task.5043 — Polygon chain-log source (current)](../../../../../../work/items/task.5043.md)
- [Phase 1 spec](../../../../../../docs/spec/poly-copy-trade-execution.md)
- [Root poly node AGENTS.md](../AGENTS.md)
- Sibling layers: [../copy-trade/AGENTS.md](../copy-trade/AGENTS.md), [../trading/AGENTS.md](../trading/AGENTS.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["features", "ports", "core", "shared", "types"],
  "must_not_import": [
    "app",
    "adapters/server",
    "adapters/worker",
    "bootstrap",
    "contracts"
  ]
}
```

`wallet-watch/` is intentionally siloed from `copy-trade/` and `trading/`. It produces `Fill[]` (from `@cogni/market-provider`) and has no opinion on what happens next. The cross-slice no-import rule is enforced by review + the `WALLET_WATCH_IS_GENERIC` invariant below; the AGENTS.md validator only models coarse layers.

## Public Surface

- **Exports (port):** `WalletActivitySource` — `fetchSince(since?: number) → {fills, newSince}`, plus optional `subscribeWake(cb) → unsubscribe` for push-on-wake. Sources that omit `subscribeWake` degrade cleanly to coordinator-tick polling.
- **Exports (adapter):** `createPolymarketChainActivitySource({ publicClient, client, wallet, logger, metrics, refreshAssetsIntervalMs?, heartbeatIntervalMs? })` — Polygon `OrderFilled` chain logs on Polymarket CTF Exchange V2 + NegRisk Exchange V2 contracts, filtered at RPC by indexed maker/taker = target wallet. Identity arrives inline (no Data-API drain on the hot path); per-wallet `listUserPositions` snapshot enriches `(condition_id, outcome, end_date)` metadata. Latency ~2s (one Polygon block) end-to-end. Replaced the Polymarket Market-channel WS + Data-API drain in task.5043 (which had ~5min cache-induced lag from the wallet-identity enrichment call).
- **Exports (pure helpers):** `decodeOrderFilledForTarget(log, wallet)`, `chainFillId({ txHash, logIndex, side, blockTs })`.
- **Exports (metrics):** `WALLET_WATCH_METRICS` (cursor/drain duration) + `WALLET_WATCH_CHAIN_METRICS` (logs/fills/skips/metadata-refresh).
- **Exports (types):** `NextFillsResult`, `PolymarketChainActivitySource`, `PolymarketChainActivitySourceDeps`.

## Invariants

- **WALLET_WATCH_IS_GENERIC** — files in this slice MUST NOT import `features/copy-trade/` or `features/trading/`. Emits the neutral `Fill` shape from `@cogni/poly-market-provider/domain/order`.
- **CHAIN_IS_AUTHORITATIVE** — fills carry on-chain settlement data: `txHash`, `logIndex`, real `block.timestamp` (fetched via memoized `getBlock`). `observed_at` is the block timestamp, not wall-clock, so the task.5042 lag histogram measures actual target → mirror latency.
- **CHAIN_REORG_POLICY_V0** — `watchContractEvent` runs with no confirmations buffer; retractions arrive as `log.removed === true`, are dropped + counted (`poly_mirror_chain_skip_total{reason="reorg"}`) but already-emitted Fills are not recalled. Orders placed on a reorged log rely on the downstream status-sync reconciler to expire/refund. v1 hardening: delay-buffer one block or `getLogs(toBlock: latest - N)`.
- **FILL_ID_SHAPE_CHAIN** — `fill_id = "chain:" + txHash + ":" + logIndex + ":" + side + ":" + blockTs` where `blockTs` is the deterministic `block.timestamp`. Cross-source collision with `data-api:` is structurally impossible (different prefix). `(target_id, fill_id)` unique-index dedupes replays and multi-pod reads correctly.
- **METADATA_FROM_POSITIONS** — `(condition_id, outcome, end_date)` enriched from `listUserPositions(wallet)`, refreshed every `refreshAssetsIntervalMs` (default 60s). Cache miss triggers immediate refresh + retry; still-missing OR empty-outcome → skip with `metadata_unresolved`. Empty-outcome skip prevents wrong-side mirroring on NegRisk multi-outcome markets.
- **CURSOR_IS_MAX_TIMESTAMP** — `newSince` = max `block.timestamp` (unix seconds) emitted this drain. Callers persist + feed back next tick.
- **SHARED_RPC_TRANSPORT** — all source instances share the caller-supplied `publicClient`. viem multiplexes the 4-per-target subscriptions onto one underlying RPC connection.
- **WAKE_FANOUT_ISOLATED** — `subscribeWake` callbacks fire inside `onLog`. One bad subscriber MUST NOT prevent other subscribers from running, MUST NOT escape `onLog`, and MUST NOT block buffering. Implementations wrap each callback in try/catch + warn-log.

## Responsibilities

- Own the `WalletActivitySource` port and its Polygon chain-log Polymarket implementation.
- Emit bounded-label skip counters for log drops (`reorg`, `decode_no_target_match`, `metadata_unresolved`, `block_timestamp_unresolved`, `schema_invalid`).
- Stay observation-only — no writes, no decisions, no placements.

## Notes

- **Why chain logs (task.5043)**: Polymarket's public Market-channel WS frames carry no maker/taker addresses, so the prior WS source had to drain the `/trades` Data-API endpoint to attach wallet identity. That endpoint is server-cached → ~5 min observed lag from target-fill to mirror-decision. CTF Exchange V2 + NegRisk Exchange V2 emit `OrderFilled(orderHash, maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee)` with `maker` and `taker` as indexed topics, so the RPC layer filters to the target wallet and identity arrives with the event. End-to-end latency ~2s (one Polygon block).
- **Why `getBlock` per unique block** (not per log): `watchContractEvent` does not surface `block.timestamp` on the log. Real timestamp is required for `observed_at` (so the task.5042 lag histogram measures the right interval) and for `fill_id` (deterministic from chain state). Memoized `blockNumber → timestamp` cache means one `getBlock` per unique block, not per log.
- **Buy/sell determination** (decoder contract): Polymarket's CTF Exchange uses `assetId = 0` for the collateral (USDC) side of any match. The party whose side has `assetId = 0` is the BUYER on this match. Target identification then maps {maker, taker} × {collateral side, outcome side} → `{ side, tokenId, price = usdc/shares }`. Four subscriptions per target (V2 × {maker, taker} + NegRisk V2 × {maker, taker}) catch both resting-order and market-order participation.
- **Metadata cache** (`METADATA_FROM_POSITIONS`): cache miss triggers an immediate `listUserPositions` refresh + retry. New-market first fills can race the positions endpoint (Polymarket's snapshot may not reflect the fresh entry within milliseconds). If still unresolved OR `outcome` is empty, the fill is skipped and counted as `metadata_unresolved`. Worth a future Gamma `/markets?clob_token_ids=...` backstop, tracked separately.
- **Reorg policy** (`CHAIN_REORG_POLICY_V0`): no confirmations buffer in v0. `removed:true` retractions are dropped + counted; orders placed on a reorged log rely on the downstream status-sync reconciler to expire/refund. The prior implicit "data-api 5-min reconciliation backstop" no longer exists — the drain was removed.
- **Liveness**: each per-wallet source emits `event:"poly.wallet_watch.ws.heartbeat"` (name reused from the WS source for Loki absence-alert continuity) every `heartbeatIntervalMs` (default 5min) carrying `logs_received_window`, `fills_emitted_window`, `buffer_size`, `cached_tokens`, `last_log_at`, `subscriptions`. The `component:"polymarket-chain-source"` label in the line body disambiguates from any legacy WS heartbeats still in Loki retention. Source bring-up + teardown additionally emit `POLY_WALLET_WATCH_CHAIN_STARTED` / `_STOPPED`.
- **Hard requirement**: `POLYGON_RPC_URL` must be set. Absent → mirror not started (single WARN log at bootstrap). Same posture as the existing Privy/AEAD missing-creds gate.
- **Not in this slice:** scheduler tick + cadence (lives in `bootstrap/jobs/copy-trade-mirror.job.ts`); the DB cursor persistence (kept on the coordinator's `runOnce` deps); the decision / policy (lives in `features/copy-trade/`).
