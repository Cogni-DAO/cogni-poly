// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core/tests/triggers`
 * Purpose: Unit tests for prediction market trigger functions.
 * Scope: Tests checkPriceMove, checkVolumeSpike, checkCrossPlatformSpread. Does not test I/O.
 * Invariants: CHEAP_BEFORE_EXPENSIVE — triggers are pure deterministic filters.
 * Side-effects: none
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  checkCrossPlatformSpread,
  checkPriceMove,
  checkVolumeSpike,
  THRESHOLDS,
} from "../src/triggers.js";

describe("checkPriceMove", () => {
  const entityId = "prediction-market:polymarket:abc";

  it("returns null when move is below threshold", () => {
    // 4% move = 400bps < 500bps threshold
    const result = checkPriceMove(entityId, 6200, 5800);
    expect(result).toBeNull();
  });

  it("fires on >5% price move", () => {
    // 6% move = 600bps > 500bps threshold
    const result = checkPriceMove(entityId, 6600, 6000);
    expect(result).not.toBeNull();
    expect(result?.triggerType).toBe("price_move");
    expect(result?.entityId).toBe(entityId);
    expect(result?.priority).toBe(600);
    expect(result?.detail).toContain("up");
  });

  it("detects downward moves", () => {
    const result = checkPriceMove(entityId, 5000, 5600);
    expect(result).not.toBeNull();
    expect(result?.detail).toContain("down");
  });

  it("fires on exactly 5% (500bps) — at-threshold fires", () => {
    const result = checkPriceMove(entityId, 5500, 5000);
    expect(result).not.toBeNull();
    expect(result?.priority).toBe(500);
  });

  it("does not fire at 499bps (just below threshold)", () => {
    const result = checkPriceMove(entityId, 5499, 5000);
    expect(result).toBeNull();
  });

  it("accepts custom threshold", () => {
    const result = checkPriceMove(entityId, 5200, 5000, 100);
    expect(result).not.toBeNull();
    expect(result?.priority).toBe(200);
  });

  it("default threshold matches THRESHOLDS constant", () => {
    expect(THRESHOLDS.PRICE_MOVE_BPS).toBe(500);
  });
});

describe("checkVolumeSpike", () => {
  const entityId = "prediction-market:polymarket:def";

  it("returns null when volume is below multiplier", () => {
    const result = checkVolumeSpike(entityId, 150, 100);
    expect(result).toBeNull();
  });

  it("fires on >2x volume spike", () => {
    const result = checkVolumeSpike(entityId, 250, 100);
    expect(result).not.toBeNull();
    expect(result?.triggerType).toBe("volume_spike");
    expect(result?.detail).toContain("2.5x");
  });

  it("returns null for zero baseline", () => {
    const result = checkVolumeSpike(entityId, 100, 0);
    expect(result).toBeNull();
  });

  it("returns null for negative baseline", () => {
    const result = checkVolumeSpike(entityId, 100, -10);
    expect(result).toBeNull();
  });

  it("accepts custom multiplier", () => {
    const result = checkVolumeSpike(entityId, 350, 100, 3.0);
    expect(result).not.toBeNull();
  });
});

describe("checkCrossPlatformSpread", () => {
  const entityId = "prediction-market:cross:ghi";

  it("returns null when spread is below threshold", () => {
    // 2% spread = 200bps < 300bps threshold
    const result = checkCrossPlatformSpread(
      entityId,
      6200,
      6000,
      "Polymarket",
      "Kalshi"
    );
    expect(result).toBeNull();
  });

  it("fires on >3% cross-platform spread", () => {
    // 5% spread = 500bps > 300bps threshold
    const result = checkCrossPlatformSpread(
      entityId,
      6500,
      6000,
      "Polymarket",
      "Kalshi"
    );
    expect(result).not.toBeNull();
    expect(result?.triggerType).toBe("cross_platform_spread");
    expect(result?.detail).toContain("Polymarket");
    expect(result?.priority).toBe(500);
  });

  it("works regardless of which platform is higher", () => {
    const result = checkCrossPlatformSpread(
      entityId,
      6000,
      6500,
      "Polymarket",
      "Kalshi"
    );
    expect(result).not.toBeNull();
    expect(result?.detail).toContain("Kalshi");
  });
});
