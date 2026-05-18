// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/plan-mirror-sizing-position-gap`
 * Purpose: Cover the `kind: "position_gap"` branch of the planner (D2 phase 2).
 * Replays the swisstony ATP Sinner/Ruud incident (2026-05-17): target's final
 * position was 88,931 sh Sinner / 14,925 sh Ruud (~99.5%/0.5%). Under the
 * legacy `target_percentile_scaled` policy the mirror inverted to 28%/72% and
 * paid 5.75× target's VWAP on Ruud. Under `position_gap` with the bootstrap
 * default `target_scale = 1e-4` the Sinner fills produce ~$7.55 of intent and
 * the Ruud fills collapse to `below_market_min` — minority side never gets
 * placed.
 * Scope: Pure function; no I/O. Exercises gap math, cumulative-intent cap,
 * layer accumulation via desired − ours, and short-circuit of layer/hedge
 * dispatch when `position_gap` is active.
 * Invariants: GAP_DRIVES_SIZING, PLAN_IS_PURE, MIRROR_REASON_BOUNDED,
 *             CAPS_LIVE_IN_GRANT.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-position-mirror.md (Phase 2),
 *        work/charters/POLY_COPY_DELTA.md (D2)
 */

import { clientOrderIdFor, type Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";

import { planMirrorFromFill } from "@/features/copy-trade/plan-mirror";
import type {
  MirrorTargetConfig,
  RuntimeState,
} from "@/features/copy-trade/types";

const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const BILLING_ACCOUNT_ID = "00000000-0000-4000-b000-000000000000";
const CREATED_BY_USER_ID = "00000000-0000-4000-a000-000000000001";
const TARGET_WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;

const CONDITION_ID = "0xcondition";
const SINNER_TOKEN_ID = "0xsinner";
const RUUD_TOKEN_ID = "0xruud";

const SINNER_TARGET_SHARES = 88_931;
const RUUD_TARGET_SHARES = 14_925;
const SINNER_PRICE = 0.85;
const RUUD_PRICE = 0.16;
const TARGET_SCALE = 1e-4;

function configForTarget(
  overrides: Partial<MirrorTargetConfig> = {}
): MirrorTargetConfig {
  return {
    target_id: TARGET_ID,
    target_wallet: TARGET_WALLET,
    billing_account_id: BILLING_ACCOUNT_ID,
    created_by_user_id: CREATED_BY_USER_ID,
    sizing: {
      kind: "position_gap",
      max_usdc_per_condition: 5,
      target_scale: TARGET_SCALE,
    },
    placement: { kind: "mirror_limit" },
    ...overrides,
  };
}

function sinnerRuudTargetPosition(): RuntimeState["target_position"] {
  return {
    condition_id: CONDITION_ID,
    tokens: [
      {
        token_id: SINNER_TOKEN_ID,
        size_shares: SINNER_TARGET_SHARES,
        cost_usdc: SINNER_TARGET_SHARES * 0.84,
        current_value_usdc: SINNER_TARGET_SHARES * SINNER_PRICE,
      },
      {
        token_id: RUUD_TOKEN_ID,
        size_shares: RUUD_TARGET_SHARES,
        cost_usdc: RUUD_TARGET_SHARES * 0.031,
        current_value_usdc: RUUD_TARGET_SHARES * RUUD_PRICE,
      },
    ],
  };
}

function makeFill(params: {
  tokenId: string;
  side?: "BUY" | "SELL";
  price: number;
  size_usdc?: number;
  fillSuffix?: string;
}): Fill {
  return {
    target_wallet: TARGET_WALLET,
    fill_id: `data-api:0xtx:${params.tokenId}:${params.side ?? "BUY"}:${
      params.fillSuffix ?? "0"
    }`,
    source: "data-api",
    market_id: CONDITION_ID,
    outcome: params.tokenId === SINNER_TOKEN_ID ? "YES" : "NO",
    side: params.side ?? "BUY",
    price: params.price,
    size_usdc: params.size_usdc ?? 100,
    observed_at: "2026-05-17T15:35:00.000Z",
    attributes: {
      asset: params.tokenId,
      condition_id: CONDITION_ID,
    },
  };
}

function baseState(): RuntimeState {
  return {
    already_placed_ids: [],
    placed_fill_ids: [],
    target_position: sinnerRuudTargetPosition(),
  };
}

describe("planMirrorFromFill() — sizing policy: kind=position_gap (D2 phase 2)", () => {
  it("places ~target_shares × scale × price on the dominant side (Sinner $0.85)", () => {
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-1",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget({
        sizing: {
          kind: "position_gap",
          max_usdc_per_condition: 15,
          target_scale: TARGET_SCALE,
        },
      }),
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
    // desired = 88931 × 1e-4 = 8.8931 sh, ours = 0, gap = 8.8931 sh,
    // gap_usdc = 8.8931 × 0.85 ≈ 7.5591.
    expect(d.intent.size_usdc).toBeCloseTo(7.5591, 3);
  });

  it("skips below_market_min on the minority side (Ruud $0.16)", () => {
    const fill = makeFill({
      tokenId: RUUD_TOKEN_ID,
      price: RUUD_PRICE,
      fillSuffix: "ruud-1",
    });
    const d = planMirrorFromFill({
      fill,
      // Disable the dominance gate so the minority leg reaches sizing.
      config: configForTarget({ min_target_side_fraction: undefined }),
      state: baseState(),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    // desired = 14925 × 1e-4 = 1.4925 sh, gap_usdc = 1.4925 × 0.16 ≈ $0.239 <
    // minUsdcNotional → below_market_min. Minority side never places.
    expect(d).toEqual({
      kind: "skip",
      reason: "below_market_min",
      position_branch: "new_entry",
    });
  });

  it("skips followup_not_needed when our shares already meet desired", () => {
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-saturated",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: {
        ...baseState(),
        position: {
          condition_id: CONDITION_ID,
          our_token_id: SINNER_TOKEN_ID,
          // Already hold more than desired (= 8.89 sh).
          our_qty_shares: 50,
          opposite_qty_shares: 0,
        },
      },
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
      reason: "followup_not_needed",
      position_branch: "new_entry",
    });
  });

  it("layer-accumulates via desired − ours and short-circuits the legacy layer branch", () => {
    // ourShares = 3 → gap = 5.8931 sh → gap_usdc ≈ 5.0091 → clamped to max 5.
    // The fact that the planner returns position_branch "new_entry" rather
    // than "layer" proves the dispatch short-circuit fires.
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-layer",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget({
        position_followup: {
          enabled: true,
          min_mirror_position_usdc: 1,
          market_floor_multiple: 1,
          min_target_hedge_ratio: 0,
          min_target_hedge_usdc: 0,
          max_hedge_fraction_of_position: 1,
          max_layer_fraction_of_position: 1,
        },
      }),
      state: {
        ...baseState(),
        position: {
          condition_id: CONDITION_ID,
          our_token_id: SINNER_TOKEN_ID,
          our_qty_shares: 3,
          opposite_qty_shares: 0,
        },
      },
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.position_branch).toBe("new_entry");
    expect(d.reason).toBe("ok");
    // gap = 5.8931 × 0.85 ≈ 5.009 → clamped to max_usdc_per_condition=5.
    expect(d.intent.size_usdc).toBeCloseTo(5, 3);
  });

  it("clamps gap above max_usdc_per_condition to the cap", () => {
    // target_scale=1e-3 → desired = 88.931 sh → gap_usdc = 88.931 × 0.85 ≈
    // $75.59. Clamp to max=5.
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-cap",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget({
        sizing: {
          kind: "position_gap",
          max_usdc_per_condition: 5,
          target_scale: 1e-3,
        },
      }),
      state: baseState(),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.intent.size_usdc).toBeCloseTo(5, 6);
  });

  it("skips below_market_min when gap is above minUsdcNotional but below the share-floor (minShares × price)", () => {
    // Low-tick markets: minShares × price > minUsdcNotional, so the effective
    // floor exceeds the USDC floor alone. A naive pre-check against
    // minUsdcNotional would let this fill through and `applyMarketFloors`
    // would clamp the gap UP to the share-floor — re-introducing the
    // inverted-weighting failure mode this policy exists to prevent.
    //
    // Fixture: mid-sized target (30,000 Sinner shares) at $0.85, minShares=5.
    //   desired   = 30000 × 1e-4 = 3 sh
    //   gap_usdc  = 3 × $0.85    = $2.55
    //   minUsdcNotional          = $1   (gap > this, naive pre-check passes)
    //   minShares × price        = $4.25 (gap < this, share-floor clamps up)
    // Effective floor must be used → skip below_market_min.
    const midSizedTarget: RuntimeState["target_position"] = {
      condition_id: CONDITION_ID,
      tokens: [
        {
          token_id: SINNER_TOKEN_ID,
          size_shares: 30_000,
          cost_usdc: 30_000 * 0.84,
          current_value_usdc: 30_000 * SINNER_PRICE,
        },
        {
          token_id: RUUD_TOKEN_ID,
          size_shares: RUUD_TARGET_SHARES,
          cost_usdc: RUUD_TARGET_SHARES * 0.031,
          current_value_usdc: RUUD_TARGET_SHARES * RUUD_PRICE,
        },
      ],
    };
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-floor",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget({
        sizing: {
          kind: "position_gap",
          max_usdc_per_condition: 15,
          target_scale: TARGET_SCALE,
        },
      }),
      state: {
        ...baseState(),
        target_position: midSizedTarget,
      },
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
      reason: "below_market_min",
      position_branch: "new_entry",
    });
  });

  it("skips position_cap_reached when cumulative intent + gap exceeds max", () => {
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-cap-cum",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget({
        sizing: {
          kind: "position_gap",
          max_usdc_per_condition: 10,
          target_scale: TARGET_SCALE,
        },
      }),
      state: {
        ...baseState(),
        // Already placed $4 of intent on Sinner; gap ≈ $7.56 → cumulative
        // 11.56 > max 10 → position_cap_reached.
        cumulative_intent_usdc_for_token: 4,
      },
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    expect(d).toEqual({
      kind: "skip",
      reason: "position_cap_reached",
      position_branch: "new_entry",
    });
  });
});
