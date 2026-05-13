// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-watch/polymarket-chain-source.mainnet-fixture.test`
 * Purpose: Real-data regression pin. Loads 6 `OrderFilled` events captured from Polygon mainnet (3 V2 + 3 NegRisk V2, swisstony wallet) and asserts that `parseAbi(...) + decodeEventLog` + our `decodeOrderFilledForTarget` produce sane prediction-market trades. This is the test that would have caught bug.5049 — synthetic fixtures alone fooled CI; only real chain bytes prove the wire format.
 * Scope: Pure — no RPC. Reads `tests/_fixtures/polymarket-orderfilled-mainnet.json`.
 * Invariants: ABI signature pinned to deployed topic0; decoder produces 0<price<1 for all real fills; both V2 and NegRisk V2 contracts share the same event shape.
 * Side-effects: none
 * Links: src/features/wallet-watch/polymarket-chain-source.ts, work/items/bug.5049
 * @internal
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { polymarketExchangeOrderFilledAbi } from "@cogni/poly-market-provider/adapters/polymarket";
import { decodeEventLog } from "viem";
import { describe, expect, it } from "vitest";

import { decodeOrderFilledForTarget } from "@/features/wallet-watch/polymarket-chain-source";

interface Fixture {
  contract: "v2" | "neg_risk_v2";
  contractAddress: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: string;
  topics: [`0x${string}`, ...`0x${string}`[]];
  data: `0x${string}`;
  args: {
    maker: `0x${string}`;
    taker: `0x${string}`;
    side: number;
    tokenId: string;
    makerAmountFilled: string;
    takerAmountFilled: string;
  };
}

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../_fixtures/polymarket-orderfilled-mainnet.json"
);

const fixtureFile = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as {
  source: string;
  capturedAt: string;
  wallet: `0x${string}`;
  fixtures: Fixture[];
};

describe("polymarket-chain-source — mainnet fixture", () => {
  it("loaded ≥4 fixtures spanning V2 + NegRisk V2", () => {
    expect(fixtureFile.fixtures.length).toBeGreaterThanOrEqual(4);
    const contracts = new Set(fixtureFile.fixtures.map((f) => f.contract));
    expect(contracts).toContain("v2");
    expect(contracts).toContain("neg_risk_v2");
  });

  it.each(
    fixtureFile.fixtures.map((f, i) => [i, f] as const)
  )("fixture[%i] — viem decodeEventLog parses real wire bytes with our pinned ABI", (_i, f) => {
    // Parsing raw on-chain topics + data with the pinned ABI is the
    // bug.5049-class regression check: if any field type/order in the ABI
    // string drifts from the deployed contract, decodeEventLog throws and
    // this test fails before the decoder ever runs.
    const decoded = decodeEventLog({
      abi: polymarketExchangeOrderFilledAbi,
      eventName: "OrderFilled",
      topics: f.topics,
      data: f.data,
    });
    expect(decoded.eventName).toBe("OrderFilled");
    expect(decoded.args.maker.toLowerCase()).toBe(f.args.maker.toLowerCase());
    expect(decoded.args.taker.toLowerCase()).toBe(f.args.taker.toLowerCase());
    expect(decoded.args.side).toBe(f.args.side);
    expect(decoded.args.tokenId.toString()).toBe(f.args.tokenId);
    expect(decoded.args.makerAmountFilled.toString()).toBe(
      f.args.makerAmountFilled
    );
    expect(decoded.args.takerAmountFilled.toString()).toBe(
      f.args.takerAmountFilled
    );
  });

  it.each(
    fixtureFile.fixtures.map((f, i) => [i, f] as const)
  )("fixture[%i] — decoder produces a valid prediction-market trade", (_i, f) => {
    // Synthesize a viem Log shape from the captured fixture and run our
    // production decoder against it. Asserts prices are in [0, 1] (valid
    // prediction-market range) and shares/usdc are positive — the kinds of
    // sanity checks that would have caught an off-by-one field offset.
    const log = {
      address: f.contractAddress,
      blockHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
      blockNumber: BigInt(f.blockNumber),
      data: f.data,
      logIndex: f.logIndex,
      topics: f.topics,
      transactionHash: f.txHash,
      transactionIndex: 0,
      removed: false,
      args: {
        orderHash: f.topics[1],
        maker: f.args.maker,
        taker: f.args.taker,
        side: f.args.side,
        tokenId: BigInt(f.args.tokenId),
        makerAmountFilled: BigInt(f.args.makerAmountFilled),
        takerAmountFilled: BigInt(f.args.takerAmountFilled),
        fee: 0n,
        builder:
          "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
        metadata:
          "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
      },
    };
    const out = decodeOrderFilledForTarget(
      // biome-ignore lint/suspicious/noExplicitAny: synthesized viem Log shape for fixture replay
      log as any,
      fixtureFile.wallet
    );
    expect(out).not.toBeNull();
    expect(out?.side).toMatch(/^(BUY|SELL)$/);
    expect(out?.shares).toBeGreaterThan(0);
    expect(out?.size_usdc).toBeGreaterThan(0);
    expect(out?.price).toBeGreaterThan(0);
    expect(out?.price).toBeLessThanOrEqual(1);
    expect(out?.tokenId).toBe(f.args.tokenId);
  });
});
