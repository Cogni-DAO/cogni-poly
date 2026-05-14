// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-watch/polymarket-chain-source.test`
 * Purpose: Unit tests for the Polygon `OrderFilled`-driven wallet-watch source (task.5043). Covers the pure decoder + `chainFillId` helper AND the behavior of `createPolymarketChainActivitySource` against stubbed `publicClient` + Data-API: empty-outcome skip, reorg drop, `getBlock` fallback, and happy-path `observed_at` from `block.timestamp`.
 * Scope: No real RPC, no DB. Stubs `watchContractEvent` (captures `onLogs`), `getBlock` (synthetic timestamps), and `listUserPositions` (synthetic positions).
 * Invariants: FILL_ID_SHAPE_CHAIN, OBSERVED_AT_IS_BLOCK_TIMESTAMP, CHAIN_REORG_POLICY_V0, METADATA_FROM_POSITIONS.
 * Side-effects: none
 * Links: src/features/wallet-watch/polymarket-chain-source.ts, work/items/task.5043
 * @internal
 */

import {
  createRecordingMetrics,
  type LoggerPort,
} from "@cogni/poly-market-provider";
import type {
  PolymarketDataApiClient,
  PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { Log, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  chainFillId,
  createPolymarketChainActivitySource,
  decodeOrderFilledForTarget,
  WALLET_WATCH_CHAIN_METRICS,
} from "@/features/wallet-watch/polymarket-chain-source";

const TARGET =
  "0xAAaaaaaAAaAaAaAAaAaaaAaaAaaAAaAaAaaAAaaa" as const satisfies `0x${string}`;
const COUNTERPARTY =
  "0xBBbbbbbBBbBbBbBBbBbbbBbbBbbBBbBbBbbBBbbb" as const satisfies `0x${string}`;
const TOKEN_ID =
  108127216264471197099847196999900611499711619131330775919076919930399030039223n;

type OrderFilledArgs = {
  orderHash: `0x${string}`;
  maker: `0x${string}`;
  taker: `0x${string}`;
  side: number;
  tokenId: bigint;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee: bigint;
  builder: `0x${string}`;
  metadata: `0x${string}`;
};

function makeLog(args: OrderFilledArgs): Log<bigint, number, false> & {
  args: OrderFilledArgs;
} {
  return {
    address: "0xE111180000d2663C0091e4f400237545B87B996B" as `0x${string}`,
    blockHash:
      "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    blockNumber: 100n,
    data: "0x" as `0x${string}`,
    logIndex: 7,
    topics: ["0xfeed", "0xorderhash", args.maker, args.taker] as unknown as Log<
      bigint,
      number,
      false
    >["topics"],
    transactionHash:
      "0xabc1230000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    transactionIndex: 1,
    removed: false,
    args,
  } as unknown as Log<bigint, number, false> & { args: OrderFilledArgs };
}

const ZERO32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const satisfies `0x${string}`;

function makerLog(
  overrides: Partial<OrderFilledArgs>
): ReturnType<typeof makeLog> {
  return makeLog({
    orderHash: "0xorderhash" as `0x${string}`,
    maker: TARGET,
    taker: COUNTERPARTY,
    side: 0,
    tokenId: TOKEN_ID,
    makerAmountFilled: 30_000_000n,
    takerAmountFilled: 50_000_000n,
    fee: 0n,
    builder: ZERO32,
    metadata: ZERO32,
    ...overrides,
  });
}

describe("decodeOrderFilledForTarget", () => {
  it("target as maker, side=BUY (0): target paid makerAmount USDC, received takerAmount shares", () => {
    // 30 USDC out, 50 shares in → price 0.60
    const log = makerLog({
      side: 0,
      makerAmountFilled: 30_000_000n,
      takerAmountFilled: 50_000_000n,
    });
    const decoded = decodeOrderFilledForTarget(log, TARGET);
    expect(decoded).not.toBeNull();
    expect(decoded?.side).toBe("BUY");
    expect(decoded?.tokenId).toBe(TOKEN_ID.toString());
    expect(decoded?.size_usdc).toBe(30);
    expect(decoded?.shares).toBe(50);
    expect(decoded?.price).toBeCloseTo(0.6, 6);
    expect(decoded?.logIndex).toBe(7);
  });

  it("target as maker, side=SELL (1): target paid makerAmount shares, received takerAmount USDC", () => {
    // 25 shares out, 15 USDC in → price 0.60
    const log = makerLog({
      side: 1,
      makerAmountFilled: 25_000_000n,
      takerAmountFilled: 15_000_000n,
    });
    const decoded = decodeOrderFilledForTarget(log, TARGET);
    expect(decoded?.side).toBe("SELL");
    expect(decoded?.tokenId).toBe(TOKEN_ID.toString());
    expect(decoded?.shares).toBe(25);
    expect(decoded?.size_usdc).toBe(15);
    expect(decoded?.price).toBeCloseTo(0.6, 6);
  });

  it("real swisstony tx 0x622ee0… maker leg decodes correctly (regression pin for bug.5049)", () => {
    // Captured from Polygon mainnet receipt of tx
    // 0x622ee0123a0dc9ca3f79c6d6638de7c1ffeebdae03f0a3f1a5fa091816e16c9f
    // log index 17: maker=swisstony, taker=exchange-self, side=0 (BUY),
    // makerAmountFilled=0x1f4fa0 USDC, takerAmountFilled=0x2b7cd0 shares.
    const log = makerLog({
      maker: "0x204f72f35326db932158cba6adff0b9a1da95e14",
      taker: "0xe111180000d2663c0091e4f400237545b87b996b",
      side: 0,
      tokenId:
        0x20137719a380ef0487e15ed9a7853217eea6d8f4343a8e3b495fe59ab69a5e1fn,
      makerAmountFilled: 0x1f4fa0n,
      takerAmountFilled: 0x2b7cd0n,
    });
    const decoded = decodeOrderFilledForTarget(
      log,
      "0x204f72f35326db932158cba6adff0b9a1da95e14"
    );
    // 0x1f4fa0 = 2_052_000 (6-dec USDC) = $2.052
    // 0x2b7cd0 = 2_850_000 (6-dec CTF shares) = 2.85
    expect(decoded?.side).toBe("BUY");
    expect(decoded?.size_usdc).toBeCloseTo(2.052, 6);
    expect(decoded?.shares).toBeCloseTo(2.85, 6);
    expect(decoded?.price).toBeCloseTo(2.052 / 2.85, 6);
  });

  it("target is NOT the maker → null (defensive; filter should have prevented this)", () => {
    const log = makerLog({
      maker: COUNTERPARTY,
      taker: TARGET, // target appears as taker — but we filter on maker only
    });
    expect(decodeOrderFilledForTarget(log, TARGET)).toBeNull();
  });

  it("invalid side value (>1) → null", () => {
    const log = makerLog({ side: 2 });
    expect(decodeOrderFilledForTarget(log, TARGET)).toBeNull();
  });

  it("zero outcome amount → null (defensive)", () => {
    const log = makerLog({
      side: 0,
      takerAmountFilled: 0n, // would-be shares received = 0
    });
    expect(decodeOrderFilledForTarget(log, TARGET)).toBeNull();
  });

  it("maker address compare is case-insensitive", () => {
    const log = makerLog({
      maker: TARGET.toLowerCase() as `0x${string}`,
      side: 0,
    });
    expect(decodeOrderFilledForTarget(log, TARGET)?.side).toBe("BUY");
  });
});

describe("chainFillId", () => {
  it("produces the FILL_ID_SHAPE_CHAIN format (txHash + logIndex + side; no timestamp)", () => {
    const id = chainFillId({
      txHash:
        "0xabc1230000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
      logIndex: 7,
      side: "BUY",
    });
    expect(id).toBe(
      "chain:0xabc1230000000000000000000000000000000000000000000000000000000000:7:BUY"
    );
  });

  it("is deterministic from chain coordinates alone (replay + multi-pod safe)", () => {
    // Two readers of the same log MUST produce the same fill_id. The id has
    // no wall-clock or block-timestamp component, so this holds even if one
    // reader is hours behind the other.
    const inputs = {
      txHash:
        "0xdeadbeef000000000000000000000000000000000000000000000000deadbeef" as `0x${string}`,
      logIndex: 3,
      side: "SELL" as const,
    };
    expect(chainFillId(inputs)).toBe(chainFillId(inputs));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Behavior tests against a stubbed PublicClient + Data-API client.
// ──────────────────────────────────────────────────────────────────────────

interface CapturedSubscription {
  args: { maker?: readonly `0x${string}`[]; taker?: readonly `0x${string}`[] };
  onLogs: (logs: readonly unknown[]) => void;
}

function makeFakeLogger(): {
  logger: LoggerPort;
  records: Array<{ level: string; obj: Record<string, unknown> }>;
} {
  const records: Array<{ level: string; obj: Record<string, unknown> }> = [];
  const make = (extra: Record<string, unknown>): LoggerPort => ({
    debug(o) {
      records.push({ level: "debug", obj: { ...extra, ...o } });
    },
    info(o) {
      records.push({ level: "info", obj: { ...extra, ...o } });
    },
    warn(o) {
      records.push({ level: "warn", obj: { ...extra, ...o } });
    },
    error(o) {
      records.push({ level: "error", obj: { ...extra, ...o } });
    },
    child(bindings) {
      return make({ ...extra, ...bindings });
    },
  });
  return { logger: make({}), records };
}

function makeOrderFilledLog(args: {
  maker: `0x${string}`;
  taker: `0x${string}`;
  side?: number;
  tokenId?: bigint;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  blockNumber?: bigint;
  logIndex?: number;
  txHash?: `0x${string}`;
  removed?: boolean;
}): Log<bigint, number, false> {
  return {
    address: "0xE111180000d2663C0091e4f400237545B87B996B" as `0x${string}`,
    blockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
    blockNumber: args.blockNumber ?? 100n,
    data: "0x" as `0x${string}`,
    logIndex: args.logIndex ?? 5,
    topics: [],
    transactionHash:
      args.txHash ??
      ("0xabc1230000000000000000000000000000000000000000000000000000000000" as `0x${string}`),
    transactionIndex: 1,
    removed: args.removed ?? false,
    args: {
      orderHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
      maker: args.maker,
      taker: args.taker,
      side: args.side ?? 0,
      tokenId: args.tokenId ?? TOKEN_ID,
      makerAmountFilled: args.makerAmountFilled,
      takerAmountFilled: args.takerAmountFilled,
      fee: 0n,
      builder: ZERO32,
      metadata: ZERO32,
    },
  } as unknown as Log<bigint, number, false>;
}

interface ChainSourceHarness {
  publicClient: PublicClient;
  dataApiClient: PolymarketDataApiClient;
  /** Subscriptions captured during `subscribeAll` — index by call order. */
  subs: CapturedSubscription[];
  /** Override `getBlock` per blockNumber; null entry → simulate RPC failure. */
  blockTs: Map<bigint, number | null>;
  /** Mutable positions snapshot returned by `listUserPositions`. */
  positions: PolymarketUserPosition[];
}

function makeHarness(opts?: {
  initialPositions?: PolymarketUserPosition[];
}): ChainSourceHarness {
  const subs: CapturedSubscription[] = [];
  const blockTs = new Map<bigint, number | null>();
  const positions: PolymarketUserPosition[] = opts?.initialPositions ?? [];

  const publicClient = {
    watchContractEvent: ({
      args,
      onLogs,
    }: {
      args: {
        maker?: readonly `0x${string}`[];
        taker?: readonly `0x${string}`[];
      };
      onLogs: (logs: readonly unknown[]) => void;
    }) => {
      subs.push({ args, onLogs });
      return () => {
        // no-op unwatch
      };
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const ts = blockTs.get(blockNumber);
      if (ts === null || ts === undefined) {
        throw new Error(`stub: no block timestamp for ${blockNumber}`);
      }
      return { timestamp: BigInt(ts) };
    },
  } as unknown as PublicClient;

  const dataApiClient = {
    async listAllUserPositions(
      _wallet: string
    ): Promise<PolymarketUserPosition[]> {
      // Return a snapshot of the current `positions` array. Tests mutate the
      // array between events to simulate Polymarket's position endpoint
      // catching up to a fresh trade. Production uses listAllUserPositions
      // (paginated walk) per bug.5055; tests stub the same method.
      return [...positions];
    },
  } as unknown as PolymarketDataApiClient;

  return { publicClient, dataApiClient, subs, blockTs, positions };
}

function makePosition(
  overrides: Partial<PolymarketUserPosition> & {
    asset: string;
    conditionId: string;
  }
): PolymarketUserPosition {
  return {
    asset: overrides.asset,
    conditionId: overrides.conditionId,
    outcome: overrides.outcome ?? "YES",
    title: overrides.title ?? "Some market",
    slug: overrides.slug ?? "some-market",
    endDate: overrides.endDate ?? "2026-12-31",
    size: overrides.size ?? 0,
    curPrice: overrides.curPrice ?? 0.5,
    avgPrice: overrides.avgPrice ?? 0.5,
    initialValue: overrides.initialValue ?? 0,
    currentValue: overrides.currentValue ?? 0,
    cashPnl: overrides.cashPnl ?? 0,
    percentPnl: overrides.percentPnl ?? 0,
    totalBought: overrides.totalBought ?? 0,
    realizedPnl: overrides.realizedPnl ?? 0,
    percentRealizedPnl: overrides.percentRealizedPnl ?? 0,
    redeemable: overrides.redeemable ?? false,
    mergeable: overrides.mergeable ?? false,
    icon: overrides.icon ?? "",
    eventSlug: overrides.eventSlug ?? "",
    negativeRisk: overrides.negativeRisk ?? false,
  } as PolymarketUserPosition;
}

/** Flush enough microtask + setTimeout queue ticks for nested async `onLog` to settle. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("createPolymarketChainActivitySource — behavior", () => {
  it("emits a Fill with observed_at = block.timestamp (ISO) when a target maker-BUY log fires", async () => {
    const harness = makeHarness({
      initialPositions: [
        makePosition({
          asset: TOKEN_ID.toString(),
          conditionId:
            "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
          outcome: "YES",
        }),
      ],
    });
    const blockNumber = 5_000_000n;
    const blockTsSec = 1_778_591_324;
    harness.blockTs.set(blockNumber, blockTsSec);

    const metrics = createRecordingMetrics();
    const { logger } = makeFakeLogger();
    const source = createPolymarketChainActivitySource({
      publicClient: harness.publicClient,
      client: harness.dataApiClient,
      wallet: TARGET,
      logger,
      metrics,
      refreshAssetsIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
    });

    // V2 + NegRisk V2, both filtered on maker = target. Two subscriptions per
    // target — was 4 before bug.5049 when we also subscribed taker-side.
    expect(harness.subs).toHaveLength(2);
    for (const s of harness.subs) {
      expect(s.args.maker).toEqual([TARGET]);
      expect(s.args.taker).toBeUndefined();
    }
    await flushAsync(); // let the cold_start metadata refresh land

    // Fire one log on the V2 maker subscription (sub[0]).
    harness.subs[0]?.onLogs([
      makeOrderFilledLog({
        maker: TARGET,
        taker: COUNTERPARTY,
        side: 0,
        tokenId: TOKEN_ID,
        makerAmountFilled: 30_000_000n,
        takerAmountFilled: 50_000_000n,
        blockNumber,
        logIndex: 7,
      }),
    ]);
    await flushAsync();

    const { fills, newSince } = await source.fetchSince(0);
    expect(fills).toHaveLength(1);
    const f = fills[0];
    if (!f) throw new Error("expected one buffered fill");
    expect(f.source).toBe("chain");
    expect(f.side).toBe("BUY");
    expect(f.fill_id).toMatch(/^chain:0xabc123.*:7:BUY$/);
    expect(f.observed_at).toBe(new Date(blockTsSec * 1000).toISOString());
    expect(f.outcome).toBe("YES");
    expect(newSince).toBe(blockTsSec);
    source.stop();
  });

  it("skips with metadata_unresolved when position outcome is empty (no wrong-leg mirror on NegRisk)", async () => {
    const harness = makeHarness({
      initialPositions: [
        makePosition({
          asset: TOKEN_ID.toString(),
          conditionId:
            "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
          outcome: "", // empty — must trigger skip, NOT silent coercion to "YES"
        }),
      ],
    });
    harness.blockTs.set(5_000_000n, 1_778_591_324);

    const metrics = createRecordingMetrics();
    const { logger, records } = makeFakeLogger();
    const source = createPolymarketChainActivitySource({
      publicClient: harness.publicClient,
      client: harness.dataApiClient,
      wallet: TARGET,
      logger,
      metrics,
      heartbeatIntervalMs: 0,
    });
    await flushAsync();

    harness.subs[0]?.onLogs([
      makeOrderFilledLog({
        maker: TARGET,
        taker: COUNTERPARTY,
        side: 0,
        tokenId: TOKEN_ID,
        makerAmountFilled: 30_000_000n,
        takerAmountFilled: 50_000_000n,
        blockNumber: 5_000_000n,
      }),
    ]);
    await flushAsync();

    const { fills } = await source.fetchSince(0);
    expect(fills).toHaveLength(0);
    const skip = metrics.emissions.find(
      (e) =>
        e.kind === "counter" &&
        e.name === WALLET_WATCH_CHAIN_METRICS.skipTotal &&
        e.labels.reason === "metadata_unresolved"
    );
    expect(skip).toBeDefined();
    const warn = records.find((r) => r.obj.phase === "metadata_unresolved");
    expect(warn?.obj.outcome_empty).toBe(true);
    source.stop();
  });

  it("drops reorg retractions (removed:true) without buffering, counts reorg skip", async () => {
    const harness = makeHarness({
      initialPositions: [
        makePosition({
          asset: TOKEN_ID.toString(),
          conditionId:
            "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
        }),
      ],
    });
    harness.blockTs.set(5_000_000n, 1_778_591_324);

    const metrics = createRecordingMetrics();
    const { logger } = makeFakeLogger();
    const source = createPolymarketChainActivitySource({
      publicClient: harness.publicClient,
      client: harness.dataApiClient,
      wallet: TARGET,
      logger,
      metrics,
      heartbeatIntervalMs: 0,
    });
    await flushAsync();

    harness.subs[0]?.onLogs([
      makeOrderFilledLog({
        maker: TARGET,
        taker: COUNTERPARTY,
        side: 0,
        tokenId: TOKEN_ID,
        makerAmountFilled: 30_000_000n,
        takerAmountFilled: 50_000_000n,
        blockNumber: 5_000_000n,
        removed: true,
      }),
    ]);
    await flushAsync();

    const { fills } = await source.fetchSince(0);
    expect(fills).toHaveLength(0);
    const reorg = metrics.emissions.find(
      (e) =>
        e.kind === "counter" &&
        e.name === WALLET_WATCH_CHAIN_METRICS.skipTotal &&
        e.labels.reason === "reorg"
    );
    expect(reorg).toBeDefined();
    source.stop();
  });

  it("falls back to wall-clock when getBlock fails — fill is NOT dropped, fallback counter increments", async () => {
    const harness = makeHarness({
      initialPositions: [
        makePosition({
          asset: TOKEN_ID.toString(),
          conditionId:
            "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
        }),
      ],
    });
    // No entry for blockNumber 5_000_000n → stub throws → fallback path.

    const metrics = createRecordingMetrics();
    const { logger } = makeFakeLogger();
    const source = createPolymarketChainActivitySource({
      publicClient: harness.publicClient,
      client: harness.dataApiClient,
      wallet: TARGET,
      logger,
      metrics,
      heartbeatIntervalMs: 0,
    });
    await flushAsync();

    const tBefore = Math.floor(Date.now() / 1000);
    harness.subs[0]?.onLogs([
      makeOrderFilledLog({
        maker: TARGET,
        taker: COUNTERPARTY,
        side: 0,
        tokenId: TOKEN_ID,
        makerAmountFilled: 30_000_000n,
        takerAmountFilled: 50_000_000n,
        blockNumber: 5_000_000n,
      }),
    ]);
    await flushAsync();
    const tAfter = Math.floor(Date.now() / 1000);

    const { fills } = await source.fetchSince(0);
    expect(fills).toHaveLength(1);
    const observedSec = Math.floor(
      new Date(fills[0]?.observed_at).getTime() / 1000
    );
    expect(observedSec).toBeGreaterThanOrEqual(tBefore);
    expect(observedSec).toBeLessThanOrEqual(tAfter);
    const fallback = metrics.emissions.find(
      (e) =>
        e.kind === "counter" &&
        e.name === WALLET_WATCH_CHAIN_METRICS.blockTimestampFallbackTotal
    );
    expect(fallback).toBeDefined();
    source.stop();
  });

  it("stop() is idempotent and clears state without throwing", async () => {
    const harness = makeHarness();
    const metrics = createRecordingMetrics();
    const { logger } = makeFakeLogger();
    const source = createPolymarketChainActivitySource({
      publicClient: harness.publicClient,
      client: harness.dataApiClient,
      wallet: TARGET,
      logger,
      metrics,
      heartbeatIntervalMs: 0,
    });
    await flushAsync();

    source.stop();
    expect(() => source.stop()).not.toThrow();
  });

  it("fan-out to subscribeWake fires on emit; one bad callback does not block others", async () => {
    const harness = makeHarness({
      initialPositions: [
        makePosition({
          asset: TOKEN_ID.toString(),
          conditionId:
            "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
        }),
      ],
    });
    harness.blockTs.set(5_000_000n, 1_778_591_324);

    const metrics = createRecordingMetrics();
    const { logger } = makeFakeLogger();
    const source = createPolymarketChainActivitySource({
      publicClient: harness.publicClient,
      client: harness.dataApiClient,
      wallet: TARGET,
      logger,
      metrics,
      heartbeatIntervalMs: 0,
    });
    await flushAsync();

    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    source.subscribeWake?.(bad);
    source.subscribeWake?.(good);

    harness.subs[0]?.onLogs([
      makeOrderFilledLog({
        maker: TARGET,
        taker: COUNTERPARTY,
        side: 0,
        tokenId: TOKEN_ID,
        makerAmountFilled: 30_000_000n,
        takerAmountFilled: 50_000_000n,
        blockNumber: 5_000_000n,
      }),
    ]);
    await flushAsync();

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    source.stop();
  });
});
