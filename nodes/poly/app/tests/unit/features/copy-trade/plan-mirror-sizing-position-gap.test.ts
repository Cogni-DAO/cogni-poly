// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/plan-mirror-sizing-position-gap`
 * Purpose: Cover `kind: "position_gap"` (task.5014 range-relative + forward-
 *          only baseline rewrite). Math: `delta = max(0, target_position -
 *          baseline)`, `relative = min(delta / target_range_max, 1.0)`,
 *          `desired = mirror_max_alloc_per_condition × relative`. NO SELL.
 *          See docs/research/poly/range-relative-mirror-2026-05-26.md.
 * Scope: Pure function; no I/O. Exercises the five canonical paths:
 *        baseline-absent, clean cold-start, late activation, range breach,
 *        no-sell-on-target-reduction.
 * Invariants: FORWARD_ONLY_VIA_BASELINE, RANGE_DRIVES_DESIRED,
 *             NO_SELL_IN_MIRROR, PLAN_IS_PURE, MIRROR_REASON_BOUNDED.
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
const TOKEN_ID = "0xsinner";
const FILL_PRICE = 0.85;

// Locked deploy values from range-relative-parameterization-2026-05-26.md.
const TARGET_RANGE_MAX_USDC = 10_000;
const MIRROR_MAX_ALLOC_PER_CONDITION_USDC = 20;

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
      target_range_max_usdc: TARGET_RANGE_MAX_USDC,
      mirror_max_alloc_per_condition_usdc: MIRROR_MAX_ALLOC_PER_CONDITION_USDC,
    },
    placement: { kind: "mirror_limit" },
    ...overrides,
  };
}

function makeFill(suffix: string): Fill {
  return {
    target_wallet: TARGET_WALLET,
    fill_id: `data-api:0xtx:${TOKEN_ID}:BUY:${suffix}`,
    source: "data-api",
    market_id: CONDITION_ID,
    outcome: "YES",
    side: "BUY",
    price: FILL_PRICE,
    size_usdc: 100,
    observed_at: "2026-05-26T15:35:00.000Z",
    attributes: {
      asset: TOKEN_ID,
      condition_id: CONDITION_ID,
    },
  };
}

interface StateInput {
  baselineUsdc?: number | undefined;
  targetPositionUsdc?: number | undefined;
  ourShares?: number;
}

function makeState(input: StateInput): RuntimeState {
  return {
    already_placed_ids: [],
    placed_fill_ids: [],
    ...(input.targetPositionUsdc !== undefined
      ? { target_position_usdc_on_condition: input.targetPositionUsdc }
      : {}),
    ...(input.baselineUsdc !== undefined
      ? { target_condition_baseline_usdc: input.baselineUsdc }
      : {}),
    ...(input.ourShares !== undefined && input.ourShares > 0
      ? {
          position: {
            condition_id: CONDITION_ID,
            our_token_id: TOKEN_ID,
            our_qty_shares: input.ourShares,
            opposite_qty_shares: 0,
          },
        }
      : {}),
  };
}

describe("planMirrorFromFill() — sizing policy: kind=position_gap (task.5014)", () => {
  it("baseline absent → skip before_baseline_snapshot (FORWARD_ONLY_VIA_BASELINE)", () => {
    const fill = makeFill("first-observation");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({
        targetPositionUsdc: 3_050,
        // baselineUsdc intentionally absent — the pipeline just captured the
        // baseline row but the planner hasn't been re-handed it yet.
      }),
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
      reason: "before_baseline_snapshot",
      position_branch: "new_entry",
    });
  });

  it("clean cold-start (baseline=0, target grows): relative walks proportionally and places", () => {
    // delta = 8000 - 0 = 8000 ; relative = 8000/10000 = 0.8
    // desired_usdc = 20 × 0.8 = $16 ; desired_shares = 16/0.85 ≈ 18.82
    // our_shares = 0 → gap_usdc = $16 → place.
    const fill = makeFill("cold-start");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({ baselineUsdc: 0, targetPositionUsdc: 8_000 }),
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
    expect(d.intent.size_usdc).toBeCloseTo(16, 2);
  });

  it("late activation (baseline = target_position): delta=0 → skip followup_not_needed", () => {
    // Operator added a tenant AFTER target already held $3,000 on this
    // condition. First post-activation fill captured baseline = $3,000.
    // Next fill arrives with target_position still ~= $3,000 → delta = 0.
    // We never catch up to the pre-existing position.
    const fill = makeFill("late-activation");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({ baselineUsdc: 3_000, targetPositionUsdc: 3_000 }),
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
      reason: "followup_not_needed",
      position_branch: "new_entry",
    });
  });

  it("range breach (delta ≥ range_max): clamp relative=1.0, place at full per-condition alloc", () => {
    // delta = 15000 - 0 = 15000 ; relative = min(15000/10000, 1) = 1.0
    // desired_usdc = 20 × 1.0 = $20 ; gap_usdc = $20 (our_shares = 0) → place.
    const fill = makeFill("range-breach");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({ baselineUsdc: 0, targetPositionUsdc: 15_000 }),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 1,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place") throw new Error(`expected place, got ${d.reason}`);
    expect(d.intent.size_usdc).toBeCloseTo(
      MIRROR_MAX_ALLOC_PER_CONDITION_USDC,
      2
    );
  });

  it("NO SELL (target reduces below baseline): delta clamped to 0 → skip followup_not_needed", () => {
    // baseline = 5000 ; target_position now = 3000 (target sold or redeemed
    // partial). delta = max(0, 3000 - 5000) = 0 → desired = 0 → skip. We hold
    // our existing position to resolution; NO mirror SELL.
    const fill = makeFill("target-reduced");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({
        baselineUsdc: 5_000,
        targetPositionUsdc: 3_000,
        ourShares: 10,
      }),
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
      reason: "followup_not_needed",
      position_branch: "new_entry",
    });
  });

  it("target_position absent → skip target_position_below_threshold (fail-closed)", () => {
    const fill = makeFill("no-target-data");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({ baselineUsdc: 0 }),
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
      reason: "target_position_below_threshold",
      position_branch: "new_entry",
    });
  });

  it("our_shares already meet desired → skip followup_not_needed", () => {
    // Same fixture as cold-start but we already own 100 shares (> 18.82 desired).
    const fill = makeFill("saturated");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({
        baselineUsdc: 0,
        targetPositionUsdc: 8_000,
        ourShares: 100,
      }),
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
      reason: "followup_not_needed",
      position_branch: "new_entry",
    });
  });

  it("gap below effective market floor → skip below_market_min (no clamp-up)", () => {
    // delta = 100 ; relative = 0.01 ; desired_usdc = $0.20 ; gap_shares =
    // 0.20/0.85 ≈ 0.235 ; gap_usdc < $1 floor → skip rather than overpay.
    const fill = makeFill("tiny-delta");
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: makeState({ baselineUsdc: 0, targetPositionUsdc: 100 }),
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
});
