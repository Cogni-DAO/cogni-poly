// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-watch/polymarket-chain-source.test`
 * Purpose: Unit tests for the pure decode + fill-id helpers used by the Polygon `OrderFilled`-driven wallet-watch source (task.5043). The subscription + buffer + viem-watch machinery is a thin shell over the existing redeem-subscriber pattern and is exercised via the broader e2e once wired; this file pins the decode contract.
 * Scope: Pure — no viem client, no DB, no network. Builds synthetic `OrderFilled` logs and asserts the decode produces the right side / token / price / size mapping.
 * Invariants: FILL_ID_SHAPE_CHAIN, CHAIN_IS_AUTHORITATIVE (decode).
 * Side-effects: none
 * Links: src/features/wallet-watch/polymarket-chain-source.ts, work/items/task.5043
 * @internal
 */

import type { Log } from "viem";
import { describe, expect, it } from "vitest";
import {
  chainFillId,
  decodeOrderFilledForTarget,
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
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee: bigint;
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
    // eventName is added by viem at decode time; we synthesize a decoded log here.
  } as unknown as Log<bigint, number, false> & { args: OrderFilledArgs };
}

describe("decodeOrderFilledForTarget", () => {
  it("target as maker buying outcome (makerAssetId=0): side=BUY, decodes price + size from amount ratio", () => {
    // Target makers a BUY: gives USDC, receives outcome shares.
    // 30 USDC for 50 shares → price 0.60
    const log = makeLog({
      orderHash: "0xorderhash" as `0x${string}`,
      maker: TARGET,
      taker: COUNTERPARTY,
      makerAssetId: 0n,
      takerAssetId: TOKEN_ID,
      makerAmountFilled: 30_000_000n, // 30 USDC (6 dec)
      takerAmountFilled: 50_000_000n, // 50 shares (6 dec)
      fee: 0n,
    });

    const decoded = decodeOrderFilledForTarget(log, TARGET, 1778591324);
    expect(decoded).not.toBeNull();
    expect(decoded?.side).toBe("BUY");
    expect(decoded?.tokenId).toBe(TOKEN_ID.toString());
    expect(decoded?.size_usdc).toBe(30);
    expect(decoded?.shares).toBe(50);
    expect(decoded?.price).toBeCloseTo(0.6, 6);
    expect(decoded?.logIndex).toBe(7);
  });

  it("target as taker buying outcome (takerAssetId=0): side=BUY", () => {
    // Target market-buys: target = taker, taker gives USDC, gets outcome from maker.
    const log = makeLog({
      orderHash: "0xorderhash" as `0x${string}`,
      maker: COUNTERPARTY,
      taker: TARGET,
      makerAssetId: TOKEN_ID,
      takerAssetId: 0n,
      makerAmountFilled: 100_000_000n, // 100 shares from maker
      takerAmountFilled: 31_000_000n, // 31 USDC from taker
      fee: 0n,
    });

    const decoded = decodeOrderFilledForTarget(log, TARGET, 1778591324);
    expect(decoded?.side).toBe("BUY");
    expect(decoded?.tokenId).toBe(TOKEN_ID.toString());
    expect(decoded?.shares).toBe(100);
    expect(decoded?.size_usdc).toBe(31);
    expect(decoded?.price).toBeCloseTo(0.31, 6);
  });

  it("target as maker selling outcome (makerAssetId=tokenId): side=SELL", () => {
    const log = makeLog({
      orderHash: "0xorderhash" as `0x${string}`,
      maker: TARGET,
      taker: COUNTERPARTY,
      makerAssetId: TOKEN_ID,
      takerAssetId: 0n,
      makerAmountFilled: 25_000_000n, // 25 shares
      takerAmountFilled: 15_000_000n, // 15 USDC
      fee: 0n,
    });

    const decoded = decodeOrderFilledForTarget(log, TARGET, 1778591324);
    expect(decoded?.side).toBe("SELL");
    expect(decoded?.tokenId).toBe(TOKEN_ID.toString());
    expect(decoded?.shares).toBe(25);
    expect(decoded?.size_usdc).toBe(15);
    expect(decoded?.price).toBeCloseTo(0.6, 6);
  });

  it("target on neither side returns null (defensive — filter should have prevented this)", () => {
    const log = makeLog({
      orderHash: "0xorderhash" as `0x${string}`,
      maker: COUNTERPARTY,
      taker: "0xCCcccccCCcCcCcCCcCcccCccCccCCcCcCccCCccc" as `0x${string}`,
      makerAssetId: 0n,
      takerAssetId: TOKEN_ID,
      makerAmountFilled: 30_000_000n,
      takerAmountFilled: 50_000_000n,
      fee: 0n,
    });

    const decoded = decodeOrderFilledForTarget(log, TARGET, 1778591324);
    expect(decoded).toBeNull();
  });

  it("both sides marked collateral (malformed match) returns null", () => {
    const log = makeLog({
      orderHash: "0xorderhash" as `0x${string}`,
      maker: TARGET,
      taker: COUNTERPARTY,
      makerAssetId: 0n,
      takerAssetId: 0n,
      makerAmountFilled: 30_000_000n,
      takerAmountFilled: 50_000_000n,
      fee: 0n,
    });
    expect(decodeOrderFilledForTarget(log, TARGET, 1778591324)).toBeNull();
  });

  it("zero outcome amount returns null (defensive)", () => {
    const log = makeLog({
      orderHash: "0xorderhash" as `0x${string}`,
      maker: TARGET,
      taker: COUNTERPARTY,
      makerAssetId: 0n,
      takerAssetId: TOKEN_ID,
      makerAmountFilled: 30_000_000n,
      takerAmountFilled: 0n,
      fee: 0n,
    });
    expect(decodeOrderFilledForTarget(log, TARGET, 1778591324)).toBeNull();
  });

  it("address comparison is case-insensitive", () => {
    const lowerTarget = TARGET.toLowerCase() as `0x${string}`;
    const log = makeLog({
      orderHash: "0xorderhash" as `0x${string}`,
      maker: lowerTarget,
      taker: COUNTERPARTY,
      makerAssetId: 0n,
      takerAssetId: TOKEN_ID,
      makerAmountFilled: 30_000_000n,
      takerAmountFilled: 50_000_000n,
      fee: 0n,
    });
    const decoded = decodeOrderFilledForTarget(log, TARGET, 1778591324);
    expect(decoded?.side).toBe("BUY");
  });
});

describe("chainFillId", () => {
  it("produces the FILL_ID_SHAPE_CHAIN format", () => {
    const id = chainFillId({
      txHash:
        "0xabc1230000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
      logIndex: 7,
      side: "BUY",
      blockTs: 1778591324,
    });
    expect(id).toBe(
      "chain:0xabc1230000000000000000000000000000000000000000000000000000000000:7:BUY:1778591324"
    );
  });

  it("is deterministic from inputs (replay-safe dedup key)", () => {
    const inputs = {
      txHash:
        "0xdeadbeef000000000000000000000000000000000000000000000000deadbeef" as `0x${string}`,
      logIndex: 3,
      side: "SELL" as const,
      blockTs: 1778600000,
    };
    expect(chainFillId(inputs)).toBe(chainFillId(inputs));
  });
});
