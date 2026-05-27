// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/contracts/copy-trade-targets-validator`
 * Purpose: Pin the cross-field rule `validatePositionGapRangeKnobs` that the
 *          POST + PATCH /api/v1/poly/copy-trade/targets routes use to return
 *          400 (instead of letting the DB CHECK 500) when a `position_gap`
 *          target is created/updated without BOTH `target_range_max_usdc`
 *          AND `mirror_max_alloc_per_condition_usdc`. task.5014 rewrite —
 *          see docs/research/poly/range-relative-mirror-2026-05-26.md.
 */

import { validatePositionGapRangeKnobs } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

describe("validatePositionGapRangeKnobs()", () => {
  it("flags position_gap missing target_range_max_usdc", () => {
    expect(
      validatePositionGapRangeKnobs({
        sizing_policy_kind: "position_gap",
        mirror_max_alloc_per_condition_usdc: 20,
      })
    ).toBe("position_gap_requires_target_range_max_usdc");
  });

  it("flags position_gap missing mirror_max_alloc_per_condition_usdc", () => {
    expect(
      validatePositionGapRangeKnobs({
        sizing_policy_kind: "position_gap",
        target_range_max_usdc: 10_000,
      })
    ).toBe("position_gap_requires_mirror_max_alloc_per_condition_usdc");
  });

  it("flags position_gap missing both knobs (range_max first)", () => {
    expect(
      validatePositionGapRangeKnobs({ sizing_policy_kind: "position_gap" })
    ).toBe("position_gap_requires_target_range_max_usdc");
  });

  it("accepts position_gap with both knobs", () => {
    expect(
      validatePositionGapRangeKnobs({
        sizing_policy_kind: "position_gap",
        target_range_max_usdc: 10_000,
        mirror_max_alloc_per_condition_usdc: 20,
      })
    ).toBeNull();
  });

  it("does NOT flag non-position_gap policies missing range knobs", () => {
    for (const kind of [
      "auto",
      "min_bet",
      "target_percentile_scaled",
    ] as const) {
      expect(
        validatePositionGapRangeKnobs({ sizing_policy_kind: kind })
      ).toBeNull();
    }
  });

  it("does NOT flag absence of sizing_policy_kind (PATCH partial input)", () => {
    expect(validatePositionGapRangeKnobs({})).toBeNull();
    expect(
      validatePositionGapRangeKnobs({ target_range_max_usdc: 10_000 })
    ).toBeNull();
    expect(
      validatePositionGapRangeKnobs({
        mirror_max_alloc_per_condition_usdc: 20,
      })
    ).toBeNull();
  });
});
