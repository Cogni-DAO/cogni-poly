// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/plan-mirror-sizing-position-gap`
 * Purpose: Cover the `kind: "position_gap"` branch of the planner (2026-05-18
 * locked redesign). Proportional whole-book copy: hold a miniature of target's
 * BOOK. Scale derived per-fill from `capital_alloc_usdc / Σ target_total_open_book_cost_usdc`.
 * Replays the swisstony ATP Sinner/Ruud incident (2026-05-17): target's final
 * position was 88,931 sh Sinner / 14,925 sh Ruud (~99.5%/0.5% by shares). Under
 * the legacy `target_percentile_scaled` policy the mirror inverted to 28%/72%
 * and paid 5.75× target's VWAP on Ruud. Under `position_gap` with alloc=$50
 * and a representative whole-book cost-basis the Sinner fills size to a few
 * dollars and the Ruud fills collapse to `below_market_min`.
 * Scope: Pure function; no I/O. Exercises proportional gap math, Σ=0 guard,
 * layer accumulation via desired − ours, short-circuit of layer/hedge
 * dispatch when `position_gap` is active.
 * Invariants: GAP_DRIVES_SIZING, PLAN_IS_PURE, MIRROR_REASON_BOUNDED,
 *             CAPS_LIVE_IN_GRANT.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-position-mirror.md (locked design note),
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
// Sinner cost: 88_931 × $0.84 ≈ $74,702 ; Ruud cost: 14_925 × $0.031 ≈ $463.
// Whole-book Σ for these two tokens ≈ $75,165. We use a slightly inflated
// $750,000 in some tests to model a target whose Sinner/Ruud condition is one
// of many open positions (illustrates the proportional shrink in a busy book).
const SINNER_RUUD_CONDITION_COST =
  SINNER_TARGET_SHARES * 0.84 + RUUD_TARGET_SHARES * 0.031;

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
      capital_alloc_usdc: 50,
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

function baseState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    already_placed_ids: [],
    placed_fill_ids: [],
    target_position: sinnerRuudTargetPosition(),
    // Default: target's whole book = the Sinner/Ruud condition (single-market
    // tape). Tests that need a fatter book override this.
    target_total_open_book_cost_usdc: SINNER_RUUD_CONDITION_COST,
    ...overrides,
  };
}

describe("planMirrorFromFill() — sizing policy: kind=position_gap (2026-05-18 redesign)", () => {
  it("scale = alloc / Σ target_book_cost; places dominant-side intent at fill.price (Sinner $0.85)", () => {
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-1",
    });
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
    // scale = 50 / 75,165.075 ≈ 0.000665
    // desired = 88_931 × 0.000665 ≈ 59.13 sh ; gap_usdc ≈ 59.13 × 0.85 ≈ $50.26
    // Clamped to alloc=$50 (sanity ceiling).
    expect(d.intent.size_usdc).toBeCloseTo(50, 1);
  });

  it("skips below_market_min on minority side (Ruud $0.16) — book-proportional slice collapses below floor", () => {
    const fill = makeFill({
      tokenId: RUUD_TOKEN_ID,
      price: RUUD_PRICE,
      fillSuffix: "ruud-1",
    });
    const d = planMirrorFromFill({
      fill,
      // Disable the dominance gate so the minority leg reaches sizing.
      config: configForTarget({ min_target_side_fraction: undefined }),
      // Bump book cost so Ruud's slice falls below the $1 floor — simulates
      // the realistic case where target's whole book is much larger than this
      // one condition.
      state: baseState({ target_total_open_book_cost_usdc: 750_000 }),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    // scale = 50 / 750_000 ≈ 6.67e-5; desired Ruud = 14_925 × 6.67e-5 ≈ 0.995 sh
    // gap_usdc ≈ 0.995 × 0.16 ≈ $0.159 → below $1 floor → skip.
    expect(d).toEqual({
      kind: "skip",
      reason: "below_market_min",
      position_branch: "new_entry",
    });
  });

  it("Σ = 0 guard: skips target_position_below_threshold when whole-book cost is missing", () => {
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-no-book",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      // Drop `target_total_open_book_cost_usdc` — simulates hydration failure
      // (Data-API down, or target closed everything between snapshot + fill).
      state: baseState({ target_total_open_book_cost_usdc: undefined }),
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
      reason: "target_position_below_threshold",
      position_branch: "new_entry",
    });
  });

  it("Σ = 0 guard: also skips when whole-book cost is explicitly 0", () => {
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-zero-book",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState({ target_total_open_book_cost_usdc: 0 }),
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
      reason: "target_position_below_threshold",
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
          // Already hold more than desired (~59 sh).
          our_qty_shares: 100,
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
    // ourShares = 30 → gap ≈ 29.13 sh → gap_usdc ≈ 24.76. PLACED at new_entry,
    // not layer (proves the legacy layer dispatch is short-circuited under
    // position_gap).
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
          our_qty_shares: 30,
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
    expect(d.intent.size_usdc).toBeCloseTo(24.76, 1);
  });

  it("low-tick markets: gap above minUsdcNotional but below minShares×price still skips below_market_min", () => {
    // Low-tick markets: minShares × price > minUsdcNotional, so the effective
    // floor exceeds the USDC floor alone. A naive pre-check against
    // minUsdcNotional would let this fill through and `applyMarketFloors`
    // would clamp the gap UP to the share-floor — re-introducing the
    // inverted-weighting failure mode this policy exists to prevent.
    //
    // Fixture: bump book cost so Sinner desired = a few shares.
    //   scale     = 50 / 1_500_000 ≈ 3.33e-5
    //   desired   = 88_931 × 3.33e-5 ≈ 2.96 sh
    //   gap_usdc  = 2.96 × $0.85 ≈ $2.52
    //   minUsdcNotional         = $1     (gap > this, naive pre-check passes)
    //   minShares × price       = $4.25  (gap < this, share-floor clamps up)
    // Effective floor must be used → skip below_market_min.
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-floor",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState({ target_total_open_book_cost_usdc: 1_500_000 }),
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

  it("clamps an over-budget gap to alloc (sanity ceiling, not a per-trade throttle)", () => {
    // alloc=$50, but target_book is small enough that gap_usdc could exceed
    // alloc on the first fill (would mean target's whole-token cost > alloc,
    // which shouldn't happen for a sane target but we sanity-clamp anyway).
    // Use a tiny book so scale ≈ 1.
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-cap",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget({
        sizing: { kind: "position_gap", capital_alloc_usdc: 5 },
      }),
      // book = $50 → scale = 5/50 = 0.1 → desired = 88_931 × 0.1 = 8_893 sh
      // gap_usdc = 8_893 × 0.85 = $7,559 → clamped to alloc $5.
      state: baseState({ target_total_open_book_cost_usdc: 50 }),
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

  it("does NOT consult cumulative_intent_usdc_for_token (no per-trade cap under position_gap)", () => {
    // Under the legacy per-leg cap, accumulated intent past
    // `max_usdc_per_condition` would skip `position_cap_reached`. Under
    // position_gap there is no per-leg cap — the alloc + grant chain handles
    // bounding. Same fixture as the dominant-side test, with cumulative
    // intent intentionally past any plausible legacy cap.
    const fill = makeFill({
      tokenId: SINNER_TOKEN_ID,
      price: SINNER_PRICE,
      fillSuffix: "sinner-no-perleg-cap",
    });
    const d = planMirrorFromFill({
      fill,
      config: configForTarget(),
      state: baseState({ cumulative_intent_usdc_for_token: 9_999 }),
      client_order_id: clientOrderIdFor(
        BILLING_ACCOUNT_ID,
        TARGET_ID,
        fill.fill_id
      ),
      min_shares: 5,
      min_usdc_notional: 1,
    });
    if (d.kind !== "place")
      throw new Error(`expected place under position_gap, got ${d.reason}`);
    expect(d.intent.size_usdc).toBeCloseTo(50, 1);
  });
});
