// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-watch/polymarket-chain-source`
 * Purpose: `WalletActivitySource` implementation that listens to Polygon `OrderFilled` events on Polymarket's CTF Exchange V2 + NegRisk Exchange V2 contracts, filtered at the RPC layer by indexed target-wallet topics. Replaces the `polymarket-ws-source` Data-API drain — the wake-up path was sub-second already, but `WS_NO_WALLET_IDENTITY` forced a ~5min `/trades` poll to attach wallet identity. Chain logs carry maker/taker as indexed event fields, so identity arrives with the data and the drain is gone.
 * Scope: One source instance per (target wallet). Holds 4 viem `watchContractEvent` subscriptions — 2 contracts × {maker = wallet, taker = wallet} — that viem multiplexes onto a single RPC transport. Decodes price/size/side from log fields alone; enriches `(condition_id, outcome, end_date)` from a `listUserPositions(wallet)` snapshot refreshed every `refreshAssetsIntervalMs`. Pushes via `subscribeWake` callbacks; `fetchSince` drains the in-memory ring buffer.
 * Invariants:
 *   - CHAIN_IS_AUTHORITATIVE — fills emitted from this source carry on-chain settlement data (txHash + logIndex + block.timestamp). Two confirmations is not required; `confirmations: 1` is the default policy. Reorgs are absorbed via the data-api 5-min reconciliation backstop (deferred — see task.5043 follow-up).
 *   - FILL_ID_SHAPE_CHAIN — `fill_id = "chain:" + txHash + ":" + logIndex + ":" + side + ":" + blockTs`. Stable across replays (txHash+logIndex is a globally unique log coordinate). The existing partial unique index on `(target_id, fill_id)` already dedupes by `fill_id`; cross-source collision with `data-api:` is structurally impossible.
 *   - CURSOR_IS_MAX_TIMESTAMP — `newSince` semantics preserved (max `block.timestamp` seen this drain, unix seconds).
 *   - SHARED_RPC_TRANSPORT — all source instances share the caller-supplied `publicClient`. viem multiplexes the 4-per-target subscriptions onto one underlying RPC connection.
 *   - METADATA_FROM_POSITIONS — `(condition_id, outcome, end_date)` is enriched from `listUserPositions(wallet)`, refreshed every `refreshAssetsIntervalMs`. Cache miss on a chain log triggers an immediate refresh; if still missing the fill is skipped with a metrics + log emission. New-market entries thus inherit at most one position-refresh of latency on the first fill.
 * Side-effects: opens 4 viem RPC subscriptions; HTTPS GETs to data-api.polymarket.com on each metadata refresh; logger + metrics; periodic heartbeat info log.
 * Links: docs/spec/poly-copy-trade-execution.md, work/items/task.5043, work/items/task.5042
 * @public
 */

import {
  type Fill,
  FillSchema,
  type LoggerPort,
  type MetricsPort,
} from "@cogni/poly-market-provider";
import {
  POLYGON_POLYMARKET_EXCHANGE_V2,
  POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2,
  type PolymarketDataApiClient,
  type PolymarketUserPosition,
  polymarketExchangeOrderFilledAbi,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { Log, PublicClient } from "viem";
import { EVENT_NAMES } from "@/shared/observability/events";

import {
  type NextFillsResult,
  WALLET_WATCH_METRICS,
  type WalletActivitySource,
} from "./types";

/** Counter / histogram names emitted by the chain source. */
export const WALLET_WATCH_CHAIN_METRICS = {
  /** `poly_mirror_chain_logs_total` — every raw `OrderFilled` log received from any subscription before decode. */
  logsTotal: "poly_mirror_chain_logs_total",
  /** `poly_mirror_chain_fills_total` — decoded + enriched Fills emitted to the buffer. */
  fillsTotal: "poly_mirror_chain_fills_total",
  /** `poly_mirror_chain_skip_total{reason}` — log dropped. Bounded reason enum: `reorg` | `decode_no_target_match` | `metadata_unresolved` | `schema_invalid`. */
  skipTotal: "poly_mirror_chain_skip_total",
  /** `poly_mirror_chain_metadata_refresh_total{trigger}` — listUserPositions refresh fires. Bounded trigger enum: `interval` | `cache_miss` | `cold_start`. */
  metadataRefreshTotal: "poly_mirror_chain_metadata_refresh_total",
  /** `poly_mirror_chain_metadata_refresh_duration_ms{trigger}` — round-trip + parse for the position snapshot. */
  metadataRefreshDurationMs: "poly_mirror_chain_metadata_refresh_duration_ms",
} as const;

/** Default cadence for `listUserPositions` refresh. Matches the legacy WS source's `refreshAssetsIntervalMs`. */
const DEFAULT_REFRESH_ASSETS_INTERVAL_MS = 60_000;
/** Default heartbeat info-log cadence (ms). Loki absence-alert key. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface PolymarketChainActivitySourceDeps {
  publicClient: PublicClient;
  /** Per-wallet Data-API client — used only for the `listUserPositions` enrichment cache. */
  client: PolymarketDataApiClient;
  /** Target's on-chain proxy wallet. */
  wallet: `0x${string}`;
  logger: LoggerPort;
  metrics: MetricsPort;
  /** Cadence to refresh the tokenId → metadata cache. Default 60 000. */
  refreshAssetsIntervalMs?: number;
  /** Heartbeat info-log cadence (ms); 0 disables. Default 5 min. */
  heartbeatIntervalMs?: number;
}

export interface PolymarketChainActivitySource extends WalletActivitySource {
  /** Drop subscriptions + cancel timers. Idempotent. */
  stop(): void;
}

interface TokenMetadata {
  conditionId: string;
  outcome: string;
  endDate: string | null;
  title: string | null;
  slug: string | null;
}

interface BufferedFill {
  fill: Fill;
  blockTs: number;
}

type Unwatch = () => void;

/** viem `decodeEventLog` result for our pinned `OrderFilled` ABI. */
type OrderFilledLog = Log<bigint, number, false> & {
  args?: {
    orderHash?: `0x${string}`;
    maker?: `0x${string}`;
    taker?: `0x${string}`;
    makerAssetId?: bigint;
    takerAssetId?: bigint;
    makerAmountFilled?: bigint;
    takerAmountFilled?: bigint;
    fee?: bigint;
  };
};

/**
 * Decode a single `OrderFilled` event for one target wallet. Returns a partial
 * Fill missing only the enrichment fields `(condition_id, outcome, attributes.*)`
 * — those come from the position cache. Returns `null` for malformed logs or
 * when the target isn't on either side (shouldn't happen if the topic filter
 * matched, but the function is defensive).
 *
 * Polymarket convention: collateral side carries `assetId = 0`. The party
 * whose side has `assetId = 0` is the BUYER on this match — they paid USDC,
 * received the outcome token.
 *
 * @public exported for unit tests.
 */
export function decodeOrderFilledForTarget(
  log: OrderFilledLog,
  target: `0x${string}`
): {
  side: "BUY" | "SELL";
  tokenId: string;
  price: number;
  size_usdc: number;
  shares: number;
  txHash: `0x${string}`;
  logIndex: number;
} | null {
  const a = log.args;
  if (!a) return null;
  const {
    maker,
    taker,
    makerAssetId,
    takerAssetId,
    makerAmountFilled,
    takerAmountFilled,
  } = a;
  if (
    !maker ||
    !taker ||
    makerAssetId === undefined ||
    takerAssetId === undefined ||
    makerAmountFilled === undefined ||
    takerAmountFilled === undefined
  ) {
    return null;
  }

  const targetLower = target.toLowerCase();
  const targetIsMaker = maker.toLowerCase() === targetLower;
  const targetIsTaker = taker.toLowerCase() === targetLower;
  if (!targetIsMaker && !targetIsTaker) return null;

  const makerIsCollateralSide = makerAssetId === 0n;
  const takerIsCollateralSide = takerAssetId === 0n;
  // Exactly one side must be the collateral side on any well-formed match.
  if (makerIsCollateralSide === takerIsCollateralSide) return null;

  let side: "BUY" | "SELL";
  let tokenIdRaw: bigint;
  let usdcAmount: bigint;
  let outcomeAmount: bigint;

  if (targetIsMaker && makerIsCollateralSide) {
    // Target gave USDC → received outcome → BUY
    side = "BUY";
    tokenIdRaw = takerAssetId;
    usdcAmount = makerAmountFilled;
    outcomeAmount = takerAmountFilled;
  } else if (targetIsMaker && !makerIsCollateralSide) {
    // Target gave outcome → received USDC → SELL
    side = "SELL";
    tokenIdRaw = makerAssetId;
    usdcAmount = takerAmountFilled;
    outcomeAmount = makerAmountFilled;
  } else if (targetIsTaker && takerIsCollateralSide) {
    side = "BUY";
    tokenIdRaw = makerAssetId;
    usdcAmount = takerAmountFilled;
    outcomeAmount = makerAmountFilled;
  } else {
    side = "SELL";
    tokenIdRaw = takerAssetId;
    usdcAmount = makerAmountFilled;
    outcomeAmount = takerAmountFilled;
  }

  if (outcomeAmount === 0n) return null;
  const shares = Number(outcomeAmount) / 1_000_000;
  const size_usdc = Number(usdcAmount) / 1_000_000;
  if (shares <= 0 || size_usdc <= 0) return null;
  const price = size_usdc / shares;

  return {
    side,
    tokenId: tokenIdRaw.toString(),
    price,
    size_usdc,
    shares,
    txHash: log.transactionHash as `0x${string}`,
    logIndex: log.logIndex,
  };
}

/** `fill_id` shape for chain-sourced fills. */
export function chainFillId(parts: {
  txHash: `0x${string}`;
  logIndex: number;
  side: "BUY" | "SELL";
  blockTs: number;
}): string {
  return `chain:${parts.txHash}:${parts.logIndex}:${parts.side}:${parts.blockTs}`;
}

export function createPolymarketChainActivitySource(
  deps: PolymarketChainActivitySourceDeps
): PolymarketChainActivitySource {
  const log = deps.logger.child({
    component: "wallet-watch",
    subcomponent: "polymarket-chain-source",
    wallet: deps.wallet,
  });
  const refreshIntervalMs =
    deps.refreshAssetsIntervalMs ?? DEFAULT_REFRESH_ASSETS_INTERVAL_MS;
  const heartbeatIntervalMs =
    deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const buffer: BufferedFill[] = [];
  const wakeListeners = new Set<() => void>();
  const tokenMeta = new Map<string, TokenMetadata>();
  const unwatches: Unwatch[] = [];
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let logsReceivedWindow = 0;
  let fillsEmittedWindow = 0;
  let lastLogAt: number | null = null;
  let refreshInFlight: Promise<void> | null = null;
  // Cursor — max `block.timestamp` (seconds) emitted to a consumer this drain.
  let highestEmittedBlockTs = 0;

  async function refreshMetadata(
    trigger: "interval" | "cache_miss" | "cold_start"
  ): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const start = Date.now();
      try {
        deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.metadataRefreshTotal, {
          trigger,
        });
        const positions: PolymarketUserPosition[] =
          await deps.client.listUserPositions(deps.wallet);
        for (const p of positions) {
          if (!p.asset || !p.conditionId) continue;
          tokenMeta.set(p.asset, {
            conditionId: p.conditionId,
            outcome: p.outcome || "",
            endDate:
              typeof p.endDate === "string" && p.endDate.length > 0
                ? p.endDate
                : null,
            title:
              typeof p.title === "string" && p.title.length > 0
                ? p.title
                : null,
            slug:
              typeof p.slug === "string" && p.slug.length > 0 ? p.slug : null,
          });
        }
        deps.metrics.observeDurationMs(
          WALLET_WATCH_CHAIN_METRICS.metadataRefreshDurationMs,
          Date.now() - start,
          { trigger }
        );
      } catch (err) {
        log.warn(
          {
            event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
            phase: "metadata_refresh_failed",
            err: err instanceof Error ? err.message : String(err),
          },
          "polymarket-chain-source: metadata refresh failed"
        );
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function onLog(rawLog: Log<bigint, number, false>): Promise<void> {
    if (stopped) return;
    if (rawLog.removed) {
      // Reorg of a previously-emitted log. v0 relies on the data-api 5-min
      // backstop for reorg reconciliation; we log + drop the retraction here.
      log.warn(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
          phase: "reorg_dropped",
          tx_hash: rawLog.transactionHash,
          log_index: rawLog.logIndex,
        },
        "polymarket-chain-source: reorg drop — v0 ignores; data-api backstop handles"
      );
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "reorg",
      });
      return;
    }
    logsReceivedWindow += 1;
    lastLogAt = Date.now();
    deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.logsTotal, {});

    // Use callback-fire wall-clock as the fill timestamp. We deliberately do
    // NOT issue `eth_getBlock` per log — that would put a per-event RPC back
    // in the hot path (the exact thing this source exists to remove). viem's
    // filter-poll cadence (set by `pollingInterval` on the publicClient) plus
    // Polygon's ~2 s block time bound this to within a few seconds of
    // chain-settlement reality, which is plenty for `observed_at` + the
    // task.5042 lag histogram. task.5043.
    const blockTs = Math.floor(Date.now() / 1000);

    const decoded = decodeOrderFilledForTarget(
      rawLog as OrderFilledLog,
      deps.wallet
    );
    if (!decoded) {
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "decode_no_target_match",
      });
      return;
    }

    let meta = tokenMeta.get(decoded.tokenId);
    if (!meta) {
      await refreshMetadata("cache_miss");
      meta = tokenMeta.get(decoded.tokenId);
    }
    if (!meta) {
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "metadata_unresolved",
      });
      log.warn(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
          phase: "metadata_unresolved",
          token_id: decoded.tokenId,
          tx_hash: decoded.txHash,
        },
        "polymarket-chain-source: tokenId not in position cache even after refresh — skipping"
      );
      return;
    }

    const fillCandidate: Fill = {
      target_wallet: deps.wallet,
      fill_id: chainFillId({
        txHash: decoded.txHash,
        logIndex: decoded.logIndex,
        side: decoded.side,
        blockTs,
      }),
      source: "chain" as const,
      market_id: `prediction-market:polymarket:${meta.conditionId}`,
      outcome: meta.outcome || "YES",
      side: decoded.side,
      price: decoded.price,
      size_usdc: decoded.size_usdc,
      observed_at: new Date(blockTs * 1000).toISOString(),
      attributes: {
        asset: decoded.tokenId,
        condition_id: meta.conditionId,
        transaction_hash: decoded.txHash,
        log_index: decoded.logIndex,
        block_number: rawLog.blockNumber?.toString() ?? null,
        ...(meta.endDate !== null ? { end_date: meta.endDate } : {}),
        ...(meta.title !== null ? { title: meta.title } : {}),
        ...(meta.slug !== null ? { slug: meta.slug } : {}),
      },
    };

    let fill: Fill;
    try {
      fill = FillSchema.parse(fillCandidate);
    } catch (err) {
      deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.skipTotal, {
        reason: "schema_invalid",
      });
      log.warn(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
          phase: "schema_invalid",
          err: err instanceof Error ? err.message : String(err),
        },
        "polymarket-chain-source: FillSchema rejected synthesized fill"
      );
      return;
    }

    buffer.push({ fill, blockTs });
    fillsEmittedWindow += 1;
    deps.metrics.incr(WALLET_WATCH_CHAIN_METRICS.fillsTotal, {});

    // Fan-out to push-on-wake subscribers, isolated per callback.
    for (const cb of [...wakeListeners]) {
      try {
        cb();
      } catch (err) {
        log.warn(
          {
            event: EVENT_NAMES.POLY_WALLET_WATCH_WS_WAKE_CALLBACK_THREW,
            err: err instanceof Error ? err.message : String(err),
          },
          "polymarket-chain-source: wake callback threw — push degraded for this frame"
        );
      }
    }
  }

  function subscribeAll(): void {
    const sides: Array<{
      contract: `0x${string}`;
      contractLabel: "exchange" | "neg_risk";
      side: "maker" | "taker";
    }> = [
      {
        contract: POLYGON_POLYMARKET_EXCHANGE_V2,
        contractLabel: "exchange",
        side: "maker",
      },
      {
        contract: POLYGON_POLYMARKET_EXCHANGE_V2,
        contractLabel: "exchange",
        side: "taker",
      },
      {
        contract: POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2,
        contractLabel: "neg_risk",
        side: "maker",
      },
      {
        contract: POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2,
        contractLabel: "neg_risk",
        side: "taker",
      },
    ];
    for (const s of sides) {
      const args =
        s.side === "maker"
          ? { maker: [deps.wallet] }
          : { taker: [deps.wallet] };
      const unwatch = deps.publicClient.watchContractEvent({
        address: s.contract,
        abi: polymarketExchangeOrderFilledAbi,
        eventName: "OrderFilled",
        args,
        onLogs: (logs) => {
          for (const lg of logs) {
            void onLog(lg as Log<bigint, number, false>);
          }
        },
        onError: (err: unknown) => {
          log.warn(
            {
              event: EVENT_NAMES.POLY_WALLET_WATCH_NORMALIZE_ERROR,
              phase: "watch_contract_event_error",
              contract: s.contractLabel,
              side: s.side,
              err: err instanceof Error ? err.message : String(err),
            },
            "polymarket-chain-source: watchContractEvent error (viem will retry)"
          );
        },
      }) as Unwatch;
      unwatches.push(unwatch);
    }
  }

  function emitHeartbeat(): void {
    log.info(
      {
        event: EVENT_NAMES.POLY_WALLET_WATCH_WS_HEARTBEAT,
        wallet: deps.wallet,
        logs_received_window: logsReceivedWindow,
        fills_emitted_window: fillsEmittedWindow,
        buffer_size: buffer.length,
        cached_tokens: tokenMeta.size,
        last_log_at: lastLogAt,
        subscriptions: unwatches.length,
      },
      "polymarket-chain-source heartbeat"
    );
    logsReceivedWindow = 0;
    fillsEmittedWindow = 0;
  }

  // Cold-start metadata prime + subscription bring-up.
  void refreshMetadata("cold_start");
  subscribeAll();
  refreshTimer = setInterval(
    () => void refreshMetadata("interval"),
    refreshIntervalMs
  );
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(emitHeartbeat, heartbeatIntervalMs);
  }
  log.info(
    {
      event: EVENT_NAMES.POLY_WALLET_WATCH_CHAIN_STARTED,
      wallet: deps.wallet,
      subscriptions: unwatches.length,
      refresh_interval_ms: refreshIntervalMs,
      heartbeat_interval_ms: heartbeatIntervalMs,
      exchange_v2: POLYGON_POLYMARKET_EXCHANGE_V2,
      neg_risk_exchange_v2: POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2,
    },
    "polymarket-chain-source: started"
  );

  return {
    async fetchSince(since?: number): Promise<NextFillsResult> {
      const start = Date.now();
      if (buffer.length === 0) {
        // Idle drain — no logs since last call. Cursor unchanged.
        deps.metrics.observeDurationMs(
          WALLET_WATCH_METRICS.fetchDurationMs,
          Date.now() - start,
          {}
        );
        return { fills: [], newSince: since ?? 0 };
      }
      // Drain the buffer atomically — splice() empties under the same event
      // loop tick that emission occurs on, so we can't lose fills mid-drain.
      const drained = buffer.splice(0, buffer.length);
      const fills = drained.map((b) => b.fill);
      let newSince = since ?? 0;
      for (const b of drained) {
        if (b.blockTs > newSince) newSince = b.blockTs;
        if (b.blockTs > highestEmittedBlockTs)
          highestEmittedBlockTs = b.blockTs;
      }
      deps.metrics.observeDurationMs(
        WALLET_WATCH_METRICS.fetchDurationMs,
        Date.now() - start,
        {}
      );
      log.debug(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_FETCH,
          wallet: deps.wallet,
          phase: "ok",
          source_mode: "chain",
          fills: fills.length,
          new_since: newSince,
        },
        "polymarket-chain-source fetch: ok"
      );
      return { fills, newSince };
    },
    subscribeWake(callback) {
      wakeListeners.add(callback);
      return () => {
        wakeListeners.delete(callback);
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      const torndown = unwatches.length;
      for (const u of unwatches) {
        try {
          u();
        } catch {
          // ignore — torn down anyway
        }
      }
      unwatches.length = 0;
      wakeListeners.clear();
      tokenMeta.clear();
      buffer.length = 0;
      log.info(
        {
          event: EVENT_NAMES.POLY_WALLET_WATCH_CHAIN_STOPPED,
          wallet: deps.wallet,
          torndown_subscriptions: torndown,
        },
        "polymarket-chain-source: stopped"
      );
    },
  };
}
