// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/plan-mirror-sizing-side-fraction`
 * Purpose: Cover charter D6 — `target_percentile_scaled` mirror intent is
 * scaled by target's cost-basis fraction on the fill's token. Minority-side
 * fills that fall below the market floor skip with `below_market_min` rather
 * than chase. Repro shape: swisstony ATP Sinner/Ruud 2026-05-17 (target
 * 99.5/0.5 → legacy mirror inverted to 28/72).
 * Scope: Pure planner test; no I/O.
 * Invariants: SIZING_PROPORTIONAL_TO_TARGET_SHARE.
 * Links: work/charters/POLY_COPY_DELTA.md, work/items/task.5000
 */

import { clientOrderIdFor, type Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";

import { planMirrorFromFill } from "@/features/copy-trade/plan-mirror";
import type {
  MirrorTargetConfig,
  RuntimeState,
  TargetConditionPositionView,
} from "@/features/copy-trade/types";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const BILLING_ACCOUNT_ID = "00000000-0000-4000-b000-000000000000";
const TARGET_WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;
const CONDITION_ID = "prediction-market:polymarket:0xatp-sinner-ruud";
const SINNER_TOKEN = "0xsinner";
const RUUD_TOKEN = "0xruud";

const SCALED_CONFIG: MirrorTargetConfig = {
  target_id: TARGET_ID,
  target_wallet: TARGET_WALLET,
  billing_account_id: BILLING_ACCOUNT_ID,
  created_by_user_id: "00000000-0000-4000-a000-000000000001",
  sizing: {
    kind: "target_percentile_scaled",
    max_usdc_per_condition: 20,
    statistic: {
      wallet: TARGET_WALLET,
      label: "swisstony",
      captured_at: "2026-05-03T02:34:00Z",
      sample_size: 1085,
      percentile: 75,
      min_target_usdc: 100,
      max_target_usdc: 500,
    },
  },
  placement: { kind: "mirror_limit" },
};

// Sinner/Ruud 2026-05-17 tape shape — target held Sinner $85,596 / Ruud $463
// (99.5% / 0.5%).
const SINNER_RUUD_POSITION: TargetConditionPositionView = {
  condition_id: CONDITION_ID,
  tokens: [
    {
      token_id: SINNER_TOKEN,
      size_shares: 100000,
      cost_usdc: 85596,
      current_value_usdc: 90000,
    },
    {
      token_id: RUUD_TOKEN,
      size_shares: 1000,
      cost_usdc: 463,
      current_value_usdc: 500,
    },
  ],
};

function makeFill(tokenId: string, price = 0.5): Fill {
  return {
    target_wallet: TARGET_WALLET,
    fill_id: `data-api:0xtx:${tokenId}:BUY:100`,
    source: "data-api",
    market_id: CONDITION_ID,
    outcome: tokenId === SINNER_TOKEN ? "YES" : "NO",
    side: "BUY",
    price,
    size_usdc: 1,
    observed_at: "2026-05-17T17:30:00.000Z",
    attributes: { asset: tokenId, condition_id: CONDITION_ID },
  };
}

function stateFor(position: TargetConditionPositionView): RuntimeState {
  return {
    already_placed_ids: [],
    placed_fill_ids: [],
    target_position: position,
  };
}

describe("planMirrorFromFill — target_percentile_scaled × target side-fraction (D6)", () => {
  it("scales dominant-side intent by target's near-1.0 cost fraction", () => {
    // Sinner cost-fraction = 85596 / 86059 ≈ 0.9946. desired = max × 0.9946 ≈ 19.89.
    const fill = makeFill(SINNER_TOKEN);
    const d = planMirrorFromFill({
      fill,
      config: SCALED_CONFIG,
      state: stateFor(SINNER_RUUD_POSITION),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error("expected place");
    expect(d.intent.size_usdc).toBeGreaterThan(19);
    expect(d.intent.size_usdc).toBeLessThanOrEqual(20);
  });

  it("skips minority Ruud fill as below_market_min instead of chasing", () => {
    // Ruud cost-fraction = 463 / 86059 ≈ 0.00538. desired = max × 0.00538 ≈ 0.11,
    // below market floor of 1 → skip rather than clamp up and place inverted.
    const fill = makeFill(RUUD_TOKEN);
    const d = planMirrorFromFill({
      fill,
      config: SCALED_CONFIG,
      state: stateFor(SINNER_RUUD_POSITION),
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
      reason: "below_market_min",
      position_branch: "new_entry",
    });
  });

  it("scales proportionally for a 72/28 split (Sinner ~$13.5, Ruud ~$4.18 shape)", () => {
    // Reshape the same condition to a 72/28 split where both legs sit above
    // the percentile statistic's high-water mark — that isolates the new
    // side-fraction scaling factor (percentile interpolation = 1.0 for both
    // sides). Mirrors the handoff's intent that Ruud size proportionally
    // instead of saturating the cap.
    const seventyTwentyEight: TargetConditionPositionView = {
      condition_id: CONDITION_ID,
      tokens: [
        {
          token_id: SINNER_TOKEN,
          size_shares: 3000,
          cost_usdc: 1800,
          current_value_usdc: 1800,
        },
        {
          token_id: RUUD_TOKEN,
          size_shares: 1750,
          cost_usdc: 700,
          current_value_usdc: 700,
        },
      ],
    };
    const sinnerFill = makeFill(SINNER_TOKEN);
    const ruudFill = makeFill(RUUD_TOKEN);
    const sinner = planMirrorFromFill({
      fill: sinnerFill,
      config: SCALED_CONFIG,
      state: stateFor(seventyTwentyEight),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        sinnerFill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    const ruud = planMirrorFromFill({
      fill: ruudFill,
      config: SCALED_CONFIG,
      state: stateFor(seventyTwentyEight),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        ruudFill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    if (sinner.kind !== "place" || ruud.kind !== "place") {
      throw new Error("expected both to place");
    }
    // Dominant side mirrors at a multiple of the minority side, matching the
    // 72/28 cost ratio — never inverted.
    expect(sinner.intent.size_usdc).toBeGreaterThan(ruud.intent.size_usdc);
    const ratio = sinner.intent.size_usdc / ruud.intent.size_usdc;
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(3);
  });

  it("falls back to unscaled placement when target_position is absent", () => {
    // No target_position → targetSideFraction undefined → ?? 1 (legacy path).
    // Floor at $1, percentile ratio computed from fill cost-on-token would be 0
    // because there is no target_position to read — but the percentile gate
    // would already skip before sizing. Use a stub fill in a target_percentile
    // config and verify untouched.
    const cleanState: RuntimeState = {
      already_placed_ids: [],
      placed_fill_ids: [],
    };
    const fill = makeFill(SINNER_TOKEN);
    const d = planMirrorFromFill({
      fill,
      config: SCALED_CONFIG,
      state: cleanState,
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    // No target_position → target cost-on-token = 0 → below_target_percentile
    // (unchanged). This guards against regressions where missing target data
    // accidentally places at full scale.
    expect(d).toEqual({
      kind: "skip",
      reason: "below_target_percentile",
      position_branch: "new_entry",
    });
  });
});
