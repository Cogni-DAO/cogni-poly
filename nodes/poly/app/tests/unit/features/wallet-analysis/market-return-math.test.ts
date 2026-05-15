// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/market-return-math`
 * Purpose: Lock the held-P/L semantics defined in
 *   market-exposure-service.ts → SINGLE_BASIS_SNAPSHOT_COST. Inputs to
 *   `positionReturnPct` are Σ snapshot.cost_basis_usdc (currently held)
 *   and Σ snapshot.current_value_usdc; return is (value − cost) / cost.
 * Scope: Pure unit. No DB, no DOM, no SQL.
 * Invariants:
 *   - HELD_PNL_BASIS — pure value/cost ratio on shares still in the
 *     position; realized SELL / merge / redeem cash flows are
 *     intentionally outside scope (see market-exposure-service.ts).
 *   - NULL_WHEN_UNDEFINED — divide-by-zero on totalBuyNotional returns
 *     null; rateGapPct degrades to null whenever either side is null.
 *   - SIGN_CONVENTION_TARGET_MINUS_US — `edgeGap` example reproduces
 *     +15.5pp / +$8.22 exactly.
 * Side-effects: none
 * Links: nodes/poly/app/src/features/wallet-analysis/server/market-return-math.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  blendTargetReturns,
  computeRealizedPnl,
  edgeGap,
  positionReturnPct,
} from "@/features/wallet-analysis/server/market-return-math";

describe("positionReturnPct — held P/L on snapshot basis", () => {
  it("simple long, still open → +30.0%", () => {
    // 100 shares bought avg $0.50, current mark $0.65 → cost $50, value $65.
    expect(
      positionReturnPct({ totalBuyNotional: 50, currentMarkValue: 65 })
    ).toBe(0.3);
  });

  it("post-merge market-maker target → reflects held shares only", () => {
    // swisstony-shaped: target BOUGHT $36k of fills but merged ~$33k back.
    // Polymarket snapshot.cost_basis on remaining held shares = $3,200.
    // current_value = $4,832. Return on the held position = +51.0%.
    // (Realized merge cash is outside this function — see module header.)
    expect(
      positionReturnPct({
        totalBuyNotional: 3200.75,
        currentMarkValue: 4832.44,
      })
    ).toBeCloseTo(0.5098, 4);
  });

  it("hedged YES + NO legs aggregated → +3.6%", () => {
    // cost basis sum 41.50 (Σ snapshot.cost across both legs),
    // current value sum 43.00.
    expect(
      positionReturnPct({ totalBuyNotional: 41.5, currentMarkValue: 43.0 })
    ).toBe(0.0361);
  });

  it("fully exited / redeemed → null (representation gap)", () => {
    // After full redemption, Polymarket zeroes both cost and value on
    // the snapshot. Held basis is undefined here; realized P/L is not
    // recoverable without redemption-event tracking (future PR).
    expect(
      positionReturnPct({ totalBuyNotional: 0, currentMarkValue: 0 })
    ).toBeNull();
  });

  it("zero buy notional → null", () => {
    expect(
      positionReturnPct({ totalBuyNotional: 0, currentMarkValue: 0 })
    ).toBeNull();
  });

  it("negative buy notional (data bug) → null", () => {
    expect(
      positionReturnPct({ totalBuyNotional: -10, currentMarkValue: 5 })
    ).toBeNull();
  });

  it("NaN inputs → null", () => {
    expect(
      positionReturnPct({
        totalBuyNotional: Number.NaN,
        currentMarkValue: 50,
      })
    ).toBeNull();
    expect(
      positionReturnPct({
        totalBuyNotional: 50,
        currentMarkValue: Number.NaN,
      })
    ).toBeNull();
  });
});

describe("edgeGap — paired us-vs-target §3.3-D", () => {
  it("D. our +17.0% vs target +32.5% → +15.5pp / +$8.22", () => {
    const result = edgeGap({
      ourReturnPct: 0.17,
      targetReturnPct: 0.325,
      ourTotalBuyNotional: 53,
    });
    expect(result.rateGapPct).toBe(0.155);
    expect(result.sizeScaledGapUsdc).toBe(8.22);
  });

  it("we-ahead case → negative gap", () => {
    const result = edgeGap({
      ourReturnPct: 0.24,
      targetReturnPct: 0.18,
      ourTotalBuyNotional: 76,
    });
    expect(result.rateGapPct).toBe(-0.06);
    expect(result.sizeScaledGapUsdc).toBe(-4.56);
  });

  it("either side null → both metrics null", () => {
    expect(
      edgeGap({
        ourReturnPct: null,
        targetReturnPct: 0.3,
        ourTotalBuyNotional: 50,
      })
    ).toEqual({ rateGapPct: null, sizeScaledGapUsdc: null });
    expect(
      edgeGap({
        ourReturnPct: 0.1,
        targetReturnPct: null,
        ourTotalBuyNotional: 50,
      })
    ).toEqual({ rateGapPct: null, sizeScaledGapUsdc: null });
  });

  it("zero our-buy-notional → rate defined, dollar gap null", () => {
    const result = edgeGap({
      ourReturnPct: 0.1,
      targetReturnPct: 0.3,
      ourTotalBuyNotional: 0,
    });
    expect(result.rateGapPct).toBe(0.2);
    expect(result.sizeScaledGapUsdc).toBeNull();
  });
});

describe("blendTargetReturns — multi-target weighting §3.5", () => {
  it("winner $400 +30% + loser $100 −20% → +20.0% blended", () => {
    expect(
      blendTargetReturns([
        { totalBuyNotional: 400, returnPct: 0.3 },
        { totalBuyNotional: 100, returnPct: -0.2 },
      ])
    ).toBe(0.2);
  });

  it("single target → that target's return", () => {
    expect(
      blendTargetReturns([{ totalBuyNotional: 100, returnPct: 0.15 }])
    ).toBe(0.15);
  });

  it("ignores null-return entries (zero-buy-notional targets)", () => {
    expect(
      blendTargetReturns([
        { totalBuyNotional: 100, returnPct: 0.3 },
        { totalBuyNotional: 0, returnPct: null },
        { totalBuyNotional: 50, returnPct: -0.1 },
      ])
    ).toBe(
      // (100 * 0.3 + 50 * -0.1) / (100 + 50) = 25 / 150 = 0.1667
      0.1667
    );
  });

  it("empty input → null", () => {
    expect(blendTargetReturns([])).toBeNull();
  });

  it("all-null entries → null", () => {
    expect(
      blendTargetReturns([
        { totalBuyNotional: 0, returnPct: null },
        { totalBuyNotional: 100, returnPct: null },
      ])
    ).toBeNull();
  });
});

describe("computeRealizedPnl", () => {
  it("open winner (mark still on chain) → no redemption credit", () => {
    const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional: 50,
      realizedCash: 0,
      currentMarkValue: 65,
      netShares: 100,
      marketOutcome: null,
    });
    expect(pnlUsd).toBe(15);
    expect(redemptionProceeds).toBe(0);
  });

  it("closed loser → −total_buy_notional", () => {
    const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional: 100,
      realizedCash: 0,
      currentMarkValue: 0,
      netShares: 500,
      marketOutcome: "loser",
    });
    expect(pnlUsd).toBe(-100);
    expect(redemptionProceeds).toBe(0);
  });

  it("redeemed winner → netShares × $1 − total_buy_notional", () => {
    const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional: 80,
      realizedCash: 0,
      currentMarkValue: 0,
      netShares: 500,
      marketOutcome: "winner",
    });
    expect(redemptionProceeds).toBe(500);
    expect(pnlUsd).toBe(420);
  });

  it("partial-sell-then-redeem winner → cash + redemption − cost", () => {
    const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional: 200,
      realizedCash: 200,
      currentMarkValue: 0,
      netShares: 600,
      marketOutcome: "winner",
    });
    expect(redemptionProceeds).toBe(600);
    expect(pnlUsd).toBe(600);
  });

  it("winner pre-redemption: redemption replaces mark (never additive)", () => {
    // The outcome — not the mark — is authoritative for resolved markets.
    // Redemption proceeds equal netShares × $1; pnl never double-counts
    // because `positionReturnPct` consumes redemption *instead of* mark.
    const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional: 30,
      realizedCash: 0,
      currentMarkValue: 100,
      netShares: 100,
      marketOutcome: "winner",
    });
    expect(redemptionProceeds).toBe(100);
    expect(pnlUsd).toBe(70);
  });

  it("fully-sold winner (no shares to redeem) → realized cash only", () => {
    const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional: 50,
      realizedCash: 80,
      currentMarkValue: 0,
      netShares: 0,
      marketOutcome: "winner",
    });
    expect(redemptionProceeds).toBe(0);
    expect(pnlUsd).toBe(30);
  });

  it("unknown outcome (market never resolved) → no redemption credit", () => {
    const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional: 100,
      realizedCash: 20,
      currentMarkValue: 0,
      netShares: 200,
      marketOutcome: "unknown",
    });
    expect(redemptionProceeds).toBe(0);
    expect(pnlUsd).toBe(-80);
  });

  it("zero capital deployed → pnlPct is null", () => {
    const { pnlPct } = computeRealizedPnl({
      totalBuyNotional: 0,
      realizedCash: 0,
      currentMarkValue: 0,
      netShares: 0,
      marketOutcome: null,
    });
    expect(pnlPct).toBeNull();
  });
});

describe("positionReturnPct — redemption proceeds threading", () => {
  it("redemption credit flows into return%", () => {
    expect(
      positionReturnPct({
        totalBuyNotional: 80,
        realizedCash: 0,
        currentMarkValue: 0,
        redemptionProceeds: 500,
      })
    ).toBe(5.25); // ($500 - $80) / $80 = 5.25x = +525%
  });

  it("default (no redemption field) preserves legacy behavior", () => {
    expect(
      positionReturnPct({
        totalBuyNotional: 50,
        realizedCash: 0,
        currentMarkValue: 65,
      })
    ).toBe(0.3);
  });
});
