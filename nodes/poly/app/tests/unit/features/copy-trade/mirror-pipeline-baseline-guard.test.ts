// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/mirror-pipeline-baseline-guard.test`
 * Purpose: task.5014 B1 regression — when `getTargetConditionPosition` fails
 *          to hydrate (returns undefined), the pipeline MUST NOT write a
 *          baseline. A baseline of 0 persisted under Data-API failure would
 *          stick forever; the next tick (after API recovery) would compute
 *          `delta = real_position − 0`, re-introducing the cold-start
 *          catch-up failure mode B1 was meant to dissolve. The planner
 *          already fails closed for this fill; the pipeline-level guard
 *          prevents the poisoned write.
 * Scope: Pure pipeline test, no DB, no network. Spies on
 *        `getOrInsertConditionBaseline`. Lives in its own file because the
 *        parent `mirror-pipeline.test.ts` is CI-excluded for pre-existing
 *        unrelated failures (see vitest.config.mts §exclude).
 * Invariants: FORWARD_ONLY_VIA_BASELINE — no `desired_usdc > 0` path exists
 *             without a hydrated target_position.
 */

import {
  clientOrderIdFor,
  createRecordingMetrics,
  type Fill,
  noopLogger,
  type OrderIntent,
  type OrderReceipt,
} from "@cogni/poly-market-provider";
import { COGNI_SYSTEM_BILLING_ACCOUNT_ID, TEST_USER_ID_1 } from "@tests/_fakes";
import { describe, expect, it, vi } from "vitest";
import { FakeOrderLedger } from "@/adapters/test";
import { runMirrorTick } from "@/features/copy-trade/mirror-pipeline";
import type { MirrorTargetConfig } from "@/features/copy-trade/types";
import type { WalletActivitySource } from "@/features/wallet-watch";

const TARGET_ID = "11111111-1111-1111-1111-111111111111";
const BILLING_ACCOUNT_ID = COGNI_SYSTEM_BILLING_ACCOUNT_ID;
const TARGET_WALLET = "0xAAaaaaaAAaAaAaAAaAaaaAaaAaaAAaAaAaaAAaaa" as const;

const POSITION_GAP_TARGET: MirrorTargetConfig = {
  target_id: TARGET_ID,
  target_wallet: TARGET_WALLET,
  billing_account_id: BILLING_ACCOUNT_ID,
  created_by_user_id: TEST_USER_ID_1,
  sizing: {
    kind: "position_gap",
    target_range_max_usdc: 10_000,
    mirror_max_alloc_per_condition_usdc: 20,
  },
  placement: { kind: "mirror_limit" },
};

const MARKET_CONSTRAINTS = async () => ({
  minShares: 1,
  minUsdcNotional: 1,
  tickSize: 0.01,
});

function makeBuyFill(): Fill {
  return {
    target_wallet: TARGET_WALLET,
    fill_id: "data-api:0xabc:12345:BUY:1713302400",
    source: "data-api",
    market_id:
      "prediction-market:polymarket:0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size_usdc: 10,
    observed_at: "2026-04-17T00:00:00.000Z",
    attributes: {
      asset: "12345",
      condition_id:
        "0x302f5a4e8b475db09ef63f2df542ce3330599c3c4b4aa58173208a60229e1374",
    },
  };
}

function makeSource(fills: Fill[]): WalletActivitySource {
  return {
    async fetchSince() {
      return { fills, newSince: Math.floor(Date.now() / 1000) };
    },
  };
}

function makeReceipt(order_id: string, cid: string): OrderReceipt {
  return {
    order_id,
    client_order_id: cid,
    status: "open",
    filled_size_usdc: 0,
    submitted_at: new Date().toISOString(),
  };
}

describe("mirror-pipeline — task.5014 B1 poisoned-baseline guard", () => {
  it("position_gap: target_position hydration fails → does NOT write baseline", async () => {
    const fill = makeBuyFill();
    const ledger = new FakeOrderLedger();
    // Data-API hydration failure — the documented Polymarket flake.
    const getTargetConditionPosition = vi.fn().mockResolvedValue(undefined);
    const getOrInsertConditionBaseline = vi.fn();
    const placeIntent = vi.fn(
      async (i: OrderIntent): Promise<OrderReceipt> =>
        makeReceipt("0xshould-not-fire", i.client_order_id)
    );

    await runMirrorTick({
      source: makeSource([fill]),
      ledger,
      placeIntent,
      target: POSITION_GAP_TARGET,
      getMarketConstraints: MARKET_CONSTRAINTS,
      getTargetConditionPosition,
      getOrInsertConditionBaseline,
      getCursor: () => undefined,
      setCursor: () => {},
      logger: noopLogger,
      metrics: createRecordingMetrics(),
    });

    // The guard: no baseline write happened. If this flips, B1 is back.
    expect(getOrInsertConditionBaseline).not.toHaveBeenCalled();
    // And no placement — planner fails closed.
    expect(placeIntent).not.toHaveBeenCalled();
    // The decisions ledger should record a skip for this fill (not place,
    // not error). Reason will be target_position_below_threshold from the
    // planner's Σ-guard.
    const decisions = ledger.decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.outcome).toBe("skipped");
  });

  it("position_gap: target_position present (even empty tokens) DOES write baseline", async () => {
    // Companion: the guard fires on `undefined` ONLY. A defined-but-empty
    // position is a legitimate clean cold-start; baseline = 0 there is
    // correct (target has $0 on the condition; next add walks delta from 0).
    const fill = makeBuyFill();
    const ledger = new FakeOrderLedger();
    const getTargetConditionPosition = vi.fn().mockResolvedValue({
      condition_id: fill.market_id,
      tokens: [],
    });
    const getOrInsertConditionBaseline = vi.fn().mockResolvedValue(0);

    await runMirrorTick({
      source: makeSource([fill]),
      ledger,
      placeIntent: vi.fn(),
      target: POSITION_GAP_TARGET,
      getMarketConstraints: MARKET_CONSTRAINTS,
      getTargetConditionPosition,
      getOrInsertConditionBaseline,
      getCursor: () => undefined,
      setCursor: () => {},
      logger: noopLogger,
      metrics: createRecordingMetrics(),
    });

    expect(getOrInsertConditionBaseline).toHaveBeenCalledTimes(1);
    expect(getOrInsertConditionBaseline.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        billingAccountId: BILLING_ACCOUNT_ID,
        targetId: TARGET_ID,
        observedTargetUsdc: 0,
        capturedAtFillId: fill.fill_id,
      })
    );
  });

  // Silences the unused-import warning on `clientOrderIdFor` if the file
  // ever drops both prior tests. Kept here as a deliberate import-canary so
  // the wire shape (`clientOrderIdFor(billing, target, fill_id)`) stays
  // exercised should the regression guard ever need extension.
  it("clientOrderIdFor wire-shape canary", () => {
    const fill = makeBuyFill();
    const cid = clientOrderIdFor(BILLING_ACCOUNT_ID, TARGET_ID, fill.fill_id);
    expect(cid.startsWith("0x")).toBe(true);
  });
});
