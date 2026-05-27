// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/plan-mirror-sizing-mirror-fill-exact`
 * Purpose: Cover the `kind: "mirror_fill_exact"` branch of the planner.
 * Verbatim per-fill mirror: `size_usdc = fill.size_usdc`,
 * `limit_price = fill.price`, market-floor clamp only, no cap, no follow-up
 * dispatch. Replays the eval scenario this policy exists for: prove that the
 * mirror reproduces target's exact wire-level order when nothing filters or
 * scales between the two.
 * Scope: Pure function; no I/O.
 * Invariants: MIRROR_FILL_EXACT_IS_VERBATIM, PLAN_IS_PURE, MIRROR_REASON_BOUNDED.
 * Links: work/items/task.5016, work/charters/POLY_ALGO_TENANT_MATRIX.md
 */

import { clientOrderIdFor, type Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";

import { planMirrorFromFill } from "@/features/copy-trade/plan-mirror";
import type {
  MirrorTargetConfig,
  RuntimeState,
} from "@/features/copy-trade/types";

const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const BILLING_ACCOUNT_ID = "00000000-0000-4000-b000-000000000000";
const CREATED_BY_USER_ID = "00000000-0000-4000-a000-000000000001";
const TARGET_WALLET = "0x204f72f35326db932158cba6adff0b9a1da95e14" as const;

const CONDITION_ID = "0xcondition";
const TOKEN_ID = "0xtoken-yes";

function configForTarget(
  overrides: Partial<MirrorTargetConfig> = {}
): MirrorTargetConfig {
  return {
    target_id: TARGET_ID,
    target_wallet: TARGET_WALLET,
    billing_account_id: BILLING_ACCOUNT_ID,
    created_by_user_id: CREATED_BY_USER_ID,
    sizing: { kind: "mirror_fill_exact" },
    placement: { kind: "mirror_limit" },
    ...overrides,
  };
}

function makeFill(params: {
  side?: "BUY" | "SELL";
  price: number;
  size_usdc: number;
  fillSuffix?: string;
}): Fill {
  return {
    target_wallet: TARGET_WALLET,
    fill_id: `data-api:0xtx:${TOKEN_ID}:${params.side ?? "BUY"}:${
      params.fillSuffix ?? "0"
    }`,
    source: "data-api",
    market_id: CONDITION_ID,
    outcome: "YES",
    side: params.side ?? "BUY",
    price: params.price,
    size_usdc: params.size_usdc,
    observed_at: "2026-05-27T18:00:00.000Z",
    attributes: {
      asset: TOKEN_ID,
      condition_id: CONDITION_ID,
    },
  };
}

function baseState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    already_placed_ids: [],
    placed_fill_ids: [],
    ...overrides,
  };
}

describe("planMirrorFromFill() — sizing policy: kind=mirror_fill_exact", () => {
  it("echoes fill.size_usdc verbatim and limit_price = fill.price", () => {
    const fill = makeFill({ price: 0.47, size_usdc: 312.5, fillSuffix: "1" });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState(),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.position_branch).toBe("new_entry");
    expect(d.reason).toBe("ok");
    expect(d.intent.size_usdc).toBeCloseTo(312.5, 6);
    expect(d.intent.limit_price).toBe(0.47);
    expect(d.intent.side).toBe("BUY");
    expect(d.intent.attributes?.token_id).toBe(TOKEN_ID);
  });

  it("no per-trade ceiling — places huge fill notional unclamped", () => {
    // 50,000 USDC at $0.85 = 58,824 shares — far above any legacy cap.
    const fill = makeFill({ price: 0.85, size_usdc: 50_000, fillSuffix: "2" });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState(),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.intent.size_usdc).toBeCloseTo(50_000, 6);
  });

  it("clamps up to market floor when fill notional is sub-floor (max(minShares×price, minUsdcNotional))", () => {
    // fill.size_usdc = 0.50 ; minUsdcNotional = $1 ; minShares×price = 5×0.10 = $0.50.
    // applyMarketFloors floors to max(minUsdcNotional, minShares×price) = $1.
    const fill = makeFill({ price: 0.1, size_usdc: 0.5, fillSuffix: "3" });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState(),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.intent.size_usdc).toBeCloseTo(1.0, 6);
  });

  it("skip already_placed when fill_id is in the placed set", () => {
    const fill = makeFill({ price: 0.5, size_usdc: 25, fillSuffix: "dup" });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState({ placed_fill_ids: [fill.fill_id] }),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    expect(d).toEqual({
      kind: "skip",
      reason: "already_placed",
      position_branch: "new_entry",
    });
  });

  it("layer/hedge follow-up is short-circuited: 2nd same-token fill routes to new_entry, not layer_scale_in", () => {
    const fill = makeFill({ price: 0.6, size_usdc: 200, fillSuffix: "layer" });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget({
        position_followup: {
          enabled: true,
          min_mirror_position_usdc: 5,
          market_floor_multiple: 5,
          min_target_hedge_ratio: 0.02,
          min_target_hedge_usdc: 5,
          max_hedge_fraction_of_position: 0.25,
          max_layer_fraction_of_position: 0.5,
        },
      }),
      // Pre-existing mirror position on same token — would normally route to
      // `layer_scale_in` under a legacy policy.
      state: baseState({
        position: {
          condition_id: CONDITION_ID,
          our_token_id: TOKEN_ID,
          our_qty_shares: 100,
          our_vwap_usdc: 0.45,
          opposite_qty_shares: 0,
        },
      }),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.position_branch).toBe("new_entry");
    expect(d.reason).toBe("ok");
    expect(d.intent.size_usdc).toBeCloseTo(200, 6);
  });

  it("ignores conviction filters (dominance + VWAP) by construction — placed even when config doesn't set them", () => {
    // 99/1 asymmetric target position: fill is on the 1% minority side.
    // Under target_percentile_scaled with `min_target_side_fraction=0.2`
    // this would skip `target_dominant_other_side`. Under mirror_fill_exact,
    // bootstrap doesn't set the gate → fill mirrors.
    const fill = makeFill({ price: 0.04, size_usdc: 50, fillSuffix: "minor" });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState({
        target_position: {
          condition_id: CONDITION_ID,
          tokens: [
            {
              token_id: "0xdominant",
              size_shares: 99_000,
              cost_usdc: 49_500,
              current_value_usdc: 49_500,
            },
            {
              token_id: TOKEN_ID,
              size_shares: 1_000,
              cost_usdc: 50,
              current_value_usdc: 50,
            },
          ],
        },
      }),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.intent.size_usdc).toBeCloseTo(50, 6);
  });
});
