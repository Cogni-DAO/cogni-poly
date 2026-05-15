// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests/unit/features/redeem/resolve-redeem-decision
 * Purpose: Unit-test the redeem candidate resolver's cached-position path used
 *   by startup catch-up replay.
 * Scope: Pure resolver behavior with mocked ports.
 * Invariants:
 *   - CATCHUP_REUSES_POSITION_SNAPSHOT: callers may pass a pre-fetched
 *     `/positions` snapshot and must not issue another Data-API read per
 *     resolved condition.
 * Links: nodes/poly/app/src/features/redeem/resolve-redeem-decision.ts
 */

import type { PolymarketUserPosition } from "@cogni/poly-market-provider/adapters/polymarket";
import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { resolveRedeemCandidatesForCondition } from "@/features/redeem/resolve-redeem-decision";

const FUNDER = "0x95e407fE03996602Ed1BF4289ecb3B5AF88b5134" as const;
const CONDITION_A =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const CONDITION_B =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

function makePosition(conditionId: string): PolymarketUserPosition {
  return {
    proxyWallet: FUNDER,
    asset: "1",
    conditionId,
    size: 1,
    avgPrice: 0.5,
    initialValue: 0.5,
    currentValue: 0.5,
    cashPnl: 0,
    percentPnl: 0,
    totalBought: 0,
    realizedPnl: 0,
    percentRealizedPnl: 0,
    curPrice: 0.5,
    redeemable: false,
    mergeable: false,
    title: "",
    slug: "",
    icon: "",
    eventId: "",
    eventSlug: "",
    outcome: "",
    outcomeIndex: 0,
    oppositeOutcome: "",
    oppositeAsset: "",
    endDate: "",
    negativeRisk: false,
  };
}

describe("resolveRedeemCandidatesForCondition", () => {
  it("uses a supplied positions snapshot instead of refetching per condition", async () => {
    const listUserPositions = vi.fn(async () => [makePosition(CONDITION_A)]);
    const multicall = vi.fn();

    const candidates = await resolveRedeemCandidatesForCondition({
      funderAddress: FUNDER,
      conditionId: CONDITION_B,
      publicClient: { multicall } as unknown as PublicClient,
      dataApiClient: { listUserPositions } as never,
      positions: [makePosition(CONDITION_A)],
    });

    expect(candidates).toEqual([]);
    expect(listUserPositions).not.toHaveBeenCalled();
    expect(multicall).not.toHaveBeenCalled();
  });

  it("fetches positions with sizeThreshold: 0 so sub-dollar winners are visible (bug.5056)", async () => {
    const listUserPositions = vi.fn(async () => [] as PolymarketUserPosition[]);
    const multicall = vi.fn();

    await resolveRedeemCandidatesForCondition({
      funderAddress: FUNDER,
      conditionId: CONDITION_A,
      publicClient: { multicall } as unknown as PublicClient,
      dataApiClient: { listUserPositions } as never,
    });

    expect(listUserPositions).toHaveBeenCalledTimes(1);
    const args = listUserPositions.mock.calls[0];
    expect(args?.[1]).toEqual(
      expect.objectContaining({
        market: CONDITION_A,
        sizeThreshold: 0,
      })
    );
  });
});
